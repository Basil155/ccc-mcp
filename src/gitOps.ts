import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { resolveProjectEntry, validateProjectDir } from "./paths.js";

/**
 * Фиксированный набор git-операций напрямую — без запуска дочернего Claude Code.
 *
 * Зачем отдельный модуль, а не runner.ts: тот заточен под долгий `claude`
 * (слот maxConcurrent, убийство группы процессов, чистка ANTHROPIC_*, отсутствие
 * stdin). Здесь нужны другие вещи — stdin для сообщения коммита, лимит на объём
 * вывода и своя чистка GIT_*-переменных, — а общего кода между ними почти нет.
 *
 * Произвольной git-команды тут нет намеренно: операция — это enum, и, например,
 * `reset` отсутствует как вариант, а не «заблокирован флагом».
 */

/** Операционный отказ: неверная форма вызова, не репозиторий, плохое имя ветки. */
export class GitOpError extends Error {}

export const GIT_OPERATIONS = [
  "status",
  "log",
  "diff",
  "branch_list",
  "branch_create",
  "add_commit",
  "checkout_branch",
] as const;

export type GitOperation = (typeof GIT_OPERATIONS)[number];

export interface GitRequest {
  operation: GitOperation;
  projectDir: string;
  allowedRoots: readonly string[];
  gitBin: string;
  /** Предел объёма stdout одной git-команды, байт. Важен прежде всего для diff. */
  maxOutputBytes: number;
  timeoutMs: number;

  path?: string | undefined;
  limit?: number | undefined;
  staged?: boolean | undefined;
  stat?: boolean | undefined;
  name?: string | undefined;
  from?: string | undefined;
  checkout?: boolean | undefined;
  paths?: readonly string[] | undefined;
  message?: string | undefined;
}

export interface GitOpResult {
  /** Канонический project_dir — он же корень репозитория и cwd процесса. */
  root: string;
  operation: GitOperation;
  /** Отработал ли git с нулевым кодом. false — это не ошибка вызова, а результат. */
  success: boolean;
  gitExitCode: number | null;
  durationMs: number;
  gitStdout: string;
  gitStderr: string;
  nextStep: string;
  /**
   * Поля, специфичные для операции, уже в snake_case.
   *
   * Отступление от «camelCase внутри, snake_case в index.ts»: тут это не доменная
   * модель, а разобранный вывод git, и таблица переименования на commits/files/
   * branches была бы полусотней строк шума ради нулевой пользы.
   */
  data: Record<string, unknown>;
  /**
   * Поля для JSONL-лога.
   *
   * Решение «что безопасно логировать» живёт рядом с данными: сюда попадают
   * счётчики, имена веток и хеши, но никогда — содержимое diff и списки путей.
   */
  logFields: Record<string, unknown>;
}

const isWindows = process.platform === "win32";

/** Разделители полей и записей в машинных форматах git (--format, -z). */
const UNIT = "";
const RECORD = "";

/** Сколько символов stdout/stderr отдаём в ответе: это сообщения, а не данные. */
const MESSAGE_LIMIT = 8192;

/**
 * Переменные, уводящие git от cwd к другому репозиторию.
 *
 * Их обязательно вычищать: сервер, запущенный из git-хука, получает GIT_DIR
 * автоматически, и тогда операции ушли бы в чужой репозиторий мимо проверки
 * project_dir — та же дыра, что и «репозиторий выше по дереву», только через
 * окружение. scrubEnv() из env.ts тут не годится: он про ключи Anthropic для
 * дочернего claude и GIT_* не покрывает.
 */
const REDIRECT_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string): string {
  const flat = text.trimEnd();
  return flat.length <= MESSAGE_LIMIT ? flat : flat.slice(0, MESSAGE_LIMIT) + "…";
}

function buildGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (REDIRECT_ENV.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  // Ни одна из наших операций не ходит в сеть, но если git всё же решит спросить
  // пароль, он должен упасть, а не повиснуть до таймаута.
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}

// --- Проба бинаря ------------------------------------------------------------

export interface GitProbe {
  bin: string;
  version: string | null;
  /** Почему git недоступен. null — всё в порядке. */
  error: string | null;
}

/**
 * Проверяет, что git запускается. Не фатальна по замыслу.
 *
 * В отличие от ClaudeRunner.probe(), отсутствие git не должно ронять сервер:
 * остальные восемь инструментов от него не зависят. Но знать об этом оператор
 * должен сразу из лога старта, а не при первом вызове run_git.
 */
export function probeGit(bin: string): GitProbe {
  if (isWindows) {
    const ext = extname(bin).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
      return {
        bin,
        version: null,
        error:
          `обёртки .cmd/.bat не поддерживаются: ${bin} — они потребовали бы запуска через shell. ` +
          `Укажите в gitBin путь к git.exe.`,
      };
    }
  }

  const res = spawnSync(bin, ["--version"], {
    env: buildGitEnv(),
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });

  if (res.error) {
    return { bin, version: null, error: `не удалось запустить ${bin}: ${errText(res.error)}` };
  }
  if (res.status !== 0) {
    return { bin, version: null, error: `${bin} --version вернул код ${String(res.status)}` };
  }
  return { bin, version: (res.stdout ?? "").trim() || "unknown", error: null };
}

// --- Запуск git --------------------------------------------------------------

interface GitContext {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  timeoutMs: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  /** Вывод обрезан по maxOutputBytes. Для diff это не ошибка, а частичный ответ. */
  truncated: boolean;
  exitCode: number | null;
}

/**
 * Запускает git с явным массивом аргументов.
 *
 * shell: false, поэтому кавычки, `$( )`, backtick и `;` внутри любого аргумента —
 * обычные байты. Сообщение коммита к тому же уходит через stdin, то есть вообще
 * не является элементом argv.
 */
function runGit(ctx: GitContext, args: string[], stdin: string | null = null): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(ctx.bin, args, {
        cwd: ctx.cwd,
        env: ctx.env,
        shell: false,
        windowsHide: true,
        stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new GitOpError(`не удалось запустить git (${ctx.bin}): ${errText(err)}`));
      return;
    }

    const outChunks: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new GitOpError(
          `git не завершился за ${ctx.timeoutMs} мс (gitTimeoutMs) и был остановлен. ` +
            `Обычная причина — затянувшийся pre-commit хук репозитория.`,
        ),
      );
    }, ctx.timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes >= ctx.maxOutputBytes) {
        // Поток не закрываем, а продолжаем вычитывать и выбрасывать: закрытие
        // трубы прислало бы git SIGPIPE, и вместо частичного diff мы получили бы
        // непонятный сбой.
        truncated = true;
        return;
      }
      const room = ctx.maxOutputBytes - outBytes;
      if (chunk.byteLength > room) {
        outChunks.push(chunk.subarray(0, room));
        outBytes += room;
        truncated = true;
        return;
      }
      outChunks.push(chunk);
      outBytes += chunk.byteLength;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes >= MESSAGE_LIMIT * 2) return;
      errChunks.push(chunk);
      errBytes += chunk.byteLength;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new GitOpError(
            `git не найден: ${ctx.bin}. Проверьте, что git установлен и доступен в PATH, ` +
              `либо задайте полный путь в gitBin конфига (или переменной CCC_GIT_BIN).`,
          ),
        );
        return;
      }
      reject(new GitOpError(`не удалось запустить git (${ctx.bin}): ${errText(err)}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        stdoutBytes: outBytes,
        truncated,
        exitCode: code,
      });
    });

    if (stdin !== null && child.stdin) {
      // Если git успел упасть раньше, запись в закрытую трубу даёт EPIPE —
      // настоящую причину покажет его собственный stderr, а не эта ошибка.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin, "utf8");
    }
  });
}

// --- Валидация формы вызова --------------------------------------------------

const ALL_PARAMS = [
  "path",
  "limit",
  "staged",
  "stat",
  "name",
  "from",
  "checkout",
  "paths",
  "message",
] as const;

type ParamName = (typeof ALL_PARAMS)[number];

const OPERATION_PARAMS: Record<
  GitOperation,
  { required: readonly ParamName[]; optional: readonly ParamName[] }
> = {
  status: { required: [], optional: ["path"] },
  log: { required: [], optional: ["path", "limit"] },
  diff: { required: [], optional: ["path", "staged", "stat"] },
  branch_list: { required: [], optional: [] },
  branch_create: { required: ["name"], optional: ["from", "checkout"] },
  add_commit: { required: ["paths", "message"], optional: [] },
  checkout_branch: { required: ["name"], optional: [] },
};

/**
 * Проверяет, что набор параметров соответствует операции.
 *
 * Лишний параметр — тоже отказ, а не молчаливое игнорирование: иначе вызывающий
 * агент, перепутавший форму вызова, получил бы «успешный» ответ не про то, что
 * просил, и узнал бы об этом в лучшем случае от пользователя.
 */
export function validateArgs(req: GitRequest): void {
  const spec = OPERATION_PARAMS[req.operation];
  const given = new Set<ParamName>();
  for (const name of ALL_PARAMS) {
    if (req[name] !== undefined) given.add(name);
  }

  for (const name of spec.required) {
    if (!given.has(name)) {
      throw new GitOpError(
        `операция ${req.operation} требует параметр ${name}. ` +
          `Обязательные параметры: ${spec.required.join(", ")}.`,
      );
    }
  }

  const allowed = new Set<ParamName>([...spec.required, ...spec.optional]);
  for (const name of given) {
    if (!allowed.has(name)) {
      const list = [...spec.required, ...spec.optional];
      throw new GitOpError(
        `параметр ${name} не применим к операции ${req.operation}. ` +
          (list.length > 0
            ? `Она принимает: ${list.join(", ")}.`
            : `Она не принимает дополнительных параметров.`),
      );
    }
  }
}

/**
 * Допустимо ли имя ветки.
 *
 * Allowlist, а не чёрный список запрещённых символов: имя ветки уходит в argv
 * позиционным аргументом, а разделителем `--` его не прикрыть — ни
 * `git branch -- <name>`, ни `git checkout <name> --` не имеют надёжной
 * семантики. Требование «первый символ буквенно-цифровой» и отсекает подмену
 * аргумента флагом вида `--upload-pack=…` или `-f`.
 *
 * Юникодные имена веток при этом отвергаются — сознательный размен: набор
 * операций здесь утилитарный, и надёжность правила важнее полноты.
 */
export function isValidBranchName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n.length === 0 || n.length > 255) return false;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(n)) return false;
  if (n.includes("..") || n.includes("//")) return false;
  if (n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock")) return false;
  if (n === "HEAD") return false;
  return true;
}

function requireBranchName(value: string, param: string): string {
  const n = value.trim();
  if (!isValidBranchName(n)) {
    throw new GitOpError(
      `недопустимое имя ветки в параметре ${param}: ${value}. ` +
        `Разрешены латинские буквы, цифры, точка, дефис, подчёркивание и слэш; ` +
        `имя не может начинаться с дефиса и содержать "..".`,
    );
  }
  return n;
}

/**
 * Проверяет, что project_dir — корень git-репозитория.
 *
 * Это не косметика ради текста ошибки. Без неё git из cwd поднялся бы вверх по
 * дереву и работал с репозиторием, лежащим ВЫШЕ разрешённого корня: при
 * allowedRoots ["/Users/x/Projects"] и project_dir "/Users/x/Projects/foo"
 * репозиторий в "/Users/x" получил бы и чтение истории, и коммиты — мимо белого
 * списка. existsSync, а не isDirectory(): в worktree и submodule .git — файл.
 */
function requireRepoRoot(root: string): void {
  if (!existsSync(join(root, ".git"))) {
    throw new GitOpError(
      `не git-репозиторий: ${root}. Каталог project_dir должен быть корнем репозитория ` +
        `(в нём должен лежать .git). Если репозиторий выше по дереву — укажите в project_dir ` +
        `именно его корень.`,
    );
  }
}

/**
 * Проверяет границу project_dir и возвращает pathspec для git.
 *
 * resolveProjectEntry здесь работает как проверка границы, а не как источник
 * пути: он канонизирует симлинки, и симлинка внутри репозитория застейджилась
 * бы как её цель вместо себя самой. Поэтому в git уходит исходный относительный
 * путь. Несуществующий путь — не ошибка: это штатный случай коммита удалённого
 * файла.
 */
function toPathspec(req: GitRequest, rel: string): string {
  resolveProjectEntry(req.projectDir, rel, req.allowedRoots);
  const normalized = rel.trim().split(sep).join("/").replace(/^\.\//, "");
  return normalized === "" || normalized === "." ? "." : normalized;
}

// --- Разбор вывода -----------------------------------------------------------

/** Записи -z: хвостовой NUL даёт пустой элемент, он не значим. */
function splitZ(text: string): string[] {
  return text.split("\0").filter((s) => s.length > 0);
}

const STATUS_LABELS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "conflicted",
};

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function describeStatus(index: string, worktree: string): string {
  if (index === "?" && worktree === "?") return "untracked";
  if (index === "!" && worktree === "!") return "ignored";
  if (CONFLICT_CODES.has(`${index}${worktree}`)) return "conflicted";
  const meaningful = index !== " " && index !== "" ? index : worktree;
  return STATUS_LABELS[meaningful] ?? "unknown";
}

interface BranchHeader {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Разбирает строку `## main...origin/main [ahead 1, behind 2]` из porcelain. */
function parseBranchHeader(line: string): BranchHeader {
  const empty: BranchHeader = { branch: null, upstream: null, ahead: 0, behind: 0 };
  let rest = line.startsWith("## ") ? line.slice(3) : line;

  if (rest === "HEAD (no branch)") return empty;
  if (rest.startsWith("No commits yet on ")) {
    return { ...empty, branch: rest.slice("No commits yet on ".length) || null };
  }

  let ahead = 0;
  let behind = 0;
  const bracket = rest.indexOf(" [");
  if (bracket !== -1 && rest.endsWith("]")) {
    const track = rest.slice(bracket + 2, -1);
    ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
    behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
    rest = rest.slice(0, bracket);
  }

  const sep2 = rest.indexOf("...");
  if (sep2 === -1) return { branch: rest || null, upstream: null, ahead, behind };
  return {
    branch: rest.slice(0, sep2) || null,
    upstream: rest.slice(sep2 + 3) || null,
    ahead,
    behind,
  };
}

interface StatusFile {
  path: string;
  index_status: string;
  worktree_status: string;
  status: string;
  orig_path: string | null;
}

function parseStatus(stdout: string): { header: BranchHeader; files: StatusFile[] } {
  const records = splitZ(stdout);
  let header: BranchHeader = { branch: null, upstream: null, ahead: 0, behind: 0 };
  const files: StatusFile[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("## ")) {
      header = parseBranchHeader(record);
      continue;
    }
    const index = record[0] ?? " ";
    const worktree = record[1] ?? " ";
    const path = record.slice(3);

    // Для переименования и копирования исходный путь идёт отдельной записью
    // сразу за новым (в -z порядок полей обратный текстовому формату).
    let origPath: string | null = null;
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
      const next = records[i + 1];
      if (next !== undefined) {
        origPath = next;
        i++;
      }
    }

    files.push({
      path,
      index_status: index,
      worktree_status: worktree,
      status: describeStatus(index, worktree),
      orig_path: origPath,
    });
  }

  return { header, files };
}

function statusRaw(files: readonly StatusFile[]): string {
  return files
    .map((f) => {
      const code = `${f.index_status}${f.worktree_status}`;
      return f.orig_path === null
        ? `${code} ${f.path}`
        : `${code} ${f.orig_path} -> ${f.path}`;
    })
    .join("\n");
}

const COMMIT_FORMAT = [
  "%H",
  "%h",
  "%an",
  "%ae",
  "%aI",
  "%s",
  "%b",
].join("%x1f");

interface CommitView {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  date: string;
  subject: string;
  body: string;
}

function parseCommits(stdout: string): CommitView[] {
  return stdout
    .split(RECORD)
    // git добавляет перевод строки после каждой записи формата — он не часть тела.
    .map((r) => r.replace(/^\r?\n/, ""))
    .filter((r) => r.length > 0 && r.includes(UNIT))
    .map((r) => {
      const f = r.split(UNIT);
      return {
        hash: f[0] ?? "",
        short_hash: f[1] ?? "",
        author_name: f[2] ?? "",
        author_email: f[3] ?? "",
        date: f[4] ?? "",
        subject: f[5] ?? "",
        body: (f[6] ?? "").replace(/\s+$/, ""),
      };
    });
}

/** Разбирает `--name-status -z`: у R/C за статусом идут два пути, иначе один. */
function parseNameStatus(stdout: string): Array<{ path: string; status: string }> {
  const tokens = splitZ(stdout);
  const out: Array<{ path: string; status: string }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]!;
    const letter = code[0] ?? "";
    if (/^[RC]\d*$/.test(code)) {
      const dst = tokens[i + 2];
      if (dst === undefined) break;
      out.push({ path: dst, status: describeStatus(letter, " ") });
      i += 2;
      continue;
    }
    const path = tokens[i + 1];
    if (path === undefined) break;
    out.push({ path, status: describeStatus(letter, " ") });
    i += 1;
  }

  return out;
}

// --- Операции ----------------------------------------------------------------

/** Подсказка при неуспехе git: агент должен показать пользователю текст git. */
function failureNextStep(operation: GitOperation, res: RunResult): string {
  const firstLine =
    (res.stderr.trim() || res.stdout.trim()).split("\n")[0]?.trim() ?? "";
  let hint =
    `Операция не выполнена: ${operation} — git вернул код ${String(res.exitCode)}` +
    (firstLine ? `: ${firstLine}` : ".") +
    ` Покажите пользователю текст из git_stderr — это сообщение самого git, а не моста.`;

  if (/user\.email|Please tell me who you are|user\.name/i.test(res.stderr)) {
    hint +=
      ` Похоже, в репозитории не настроен автор коммитов: нужен ` +
      `git config user.name и git config user.email.`;
  }
  return hint;
}

function failure(
  req: GitRequest,
  root: string,
  res: RunResult,
  startedAt: number,
  logFields: Record<string, unknown> = {},
): GitOpResult {
  return {
    root,
    operation: req.operation,
    success: false,
    gitExitCode: res.exitCode,
    durationMs: Date.now() - startedAt,
    gitStdout: clip(res.stdout),
    gitStderr: clip(res.stderr),
    nextStep: failureNextStep(req.operation, res),
    data: {},
    logFields,
  };
}

/** Текущая ветка: null для detached HEAD и для репозитория без коммитов. */
async function currentBranch(ctx: GitContext): Promise<string | null> {
  const res = await runGit(ctx, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}

async function branchExists(ctx: GitContext, name: string): Promise<boolean> {
  const res = await runGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  return res.exitCode === 0;
}

/**
 * Выполняет git-операцию.
 *
 * Ошибки делятся на два канала. Всё, что проверено ДО запуска git (границы,
 * форма вызова, имя ветки, отсутствие ветки при checkout), — это GitOpError,
 * то есть отказ инструмента. Всё, что может установить только git (нечего
 * коммитить, грязное дерево, отказ хука), возвращается как success: false с
 * его собственным stderr: вызывающему агенту нужно показать пользователю текст
 * git, а не обобщённую ошибку.
 */
export async function runGitOperation(req: GitRequest): Promise<GitOpResult> {
  const startedAt = Date.now();

  const root = validateProjectDir(req.projectDir, req.allowedRoots);
  requireRepoRoot(root);
  validateArgs(req);

  const ctx: GitContext = {
    bin: req.gitBin,
    cwd: root,
    env: buildGitEnv(),
    maxOutputBytes: req.maxOutputBytes,
    timeoutMs: req.timeoutMs,
  };

  const ok = (
    res: RunResult,
    nextStep: string,
    data: Record<string, unknown>,
    logFields: Record<string, unknown>,
  ): GitOpResult => ({
    root,
    operation: req.operation,
    success: true,
    gitExitCode: res.exitCode,
    durationMs: Date.now() - startedAt,
    gitStdout: clip(res.stdout),
    gitStderr: clip(res.stderr),
    nextStep,
    data,
    logFields,
  });

  switch (req.operation) {
    case "status": {
      const args = ["status", "--porcelain=v1", "-z", "--branch"];
      if (req.path !== undefined) args.push("--", toPathspec(req, req.path));

      const res = await runGit(ctx, args);
      if (res.exitCode !== 0) return failure(req, root, res, startedAt);

      const { header, files } = parseStatus(res.stdout);
      const clean = files.length === 0;
      return ok(
        res,
        clean
          ? `Рабочее дерево чистое, коммитить нечего.`
          : `Изменений: ${files.length}. Чтобы закоммитить, вызовите run_git с ` +
            `operation "add_commit", перечислив нужные пути в paths и передав message.`,
        {
          clean,
          branch: header.branch,
          upstream: header.upstream,
          ahead: header.ahead,
          behind: header.behind,
          files,
          count: files.length,
          raw: statusRaw(files),
          path: req.path ?? null,
        },
        { changed_count: files.length, branch: header.branch },
      );
    }

    case "log": {
      const limit = req.limit ?? 10;
      const args = ["log", `--max-count=${limit}`, `--format=${COMMIT_FORMAT}%x1e`];
      if (req.path !== undefined) args.push("--", toPathspec(req, req.path));

      const res = await runGit(ctx, args);
      if (res.exitCode !== 0) return failure(req, root, res, startedAt, { limit });

      const commits = parseCommits(res.stdout);
      return ok(
        res,
        commits.length === 0
          ? `История пуста по этому запросу.`
          : `Показаны ${commits.length} последних коммитов (limit ${limit}). ` +
            `Чтобы увидеть больше, повторите с бо́льшим limit.`,
        { commits, count: commits.length, limit, path: req.path ?? null },
        { limit, count: commits.length },
      );
    }

    case "diff": {
      const staged = req.staged ?? false;
      const stat = req.stat ?? false;
      const args = ["diff", "--no-color"];
      if (staged) args.push("--cached");
      if (stat) args.push("--stat");
      if (req.path !== undefined) args.push("--", toPathspec(req, req.path));

      const res = await runGit(ctx, args);
      if (res.exitCode !== 0) {
        return failure(req, root, res, startedAt, { staged, stat });
      }

      // Обрезка здесь — не ошибка, а частичный ответ: оборванный патч всё равно
      // показывает, что происходит. Та же логика, что у truncated в листинге.
      const nextStep = res.truncated
        ? `Дифф обрезан по лимиту maxDiffBytes (${req.maxOutputBytes} байт). ` +
          `Сузьте область параметром path или запросите сводку с stat: true.`
        : res.stdout.length === 0
          ? staged
            ? `Застейдженных изменений нет.`
            : `Незастейдженных изменений нет. Для проиндексированных передайте staged: true.`
          : `Дифф получен целиком.`;

      return ok(
        res,
        nextStep,
        {
          diff: res.stdout,
          staged,
          stat,
          path: req.path ?? null,
          bytes: res.stdoutBytes,
          truncated: res.truncated,
        },
        { staged, stat, bytes: res.stdoutBytes, truncated: res.truncated },
      );
    }

    case "branch_list": {
      // for-each-ref, а не `git branch`: последний подмешивает псевдострочку
      // «(HEAD detached at …)», которую пришлось бы отфильтровывать.
      const format = [
        "%(HEAD)",
        "%(refname:short)",
        "%(objectname:short)",
        "%(upstream:short)",
        "%(contents:subject)",
      ].join("%1f");

      const res = await runGit(ctx, ["for-each-ref", `--format=${format}`, "refs/heads/"]);
      if (res.exitCode !== 0) return failure(req, root, res, startedAt);

      const branches = res.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const f = line.split(UNIT);
          return {
            name: f[1] ?? "",
            head: (f[0] ?? "").trim() === "*",
            commit: f[2] ?? "",
            upstream: (f[3] ?? "") || null,
            subject: f[4] ?? "",
          };
        });

      const current = branches.find((b) => b.head)?.name ?? null;
      return ok(
        res,
        branches.length === 0
          ? `Локальных веток нет — в репозитории ещё не было коммитов.`
          : current === null
            ? `Веток: ${branches.length}. HEAD отсоединён (detached), текущей ветки нет.`
            : `Веток: ${branches.length}, текущая — ${current}.`,
        { branches, current, count: branches.length },
        { count: branches.length, branch: current },
      );
    }

    case "branch_create": {
      const name = requireBranchName(req.name!, "name");
      const from = req.from === undefined ? null : requireBranchName(req.from, "from");
      const checkout = req.checkout ?? false;

      if (await branchExists(ctx, name)) {
        throw new GitOpError(
          `ветка уже существует: ${name}. Чтобы переключиться на неё, вызовите run_git ` +
            `с operation "checkout_branch".`,
        );
      }
      if (from !== null && !(await branchExists(ctx, from))) {
        throw new GitOpError(
          `ветка-источник не найдена: ${from}. Существующие ветки покажет ` +
            `operation "branch_list".`,
        );
      }

      // checkout -b атомарен: при раздельных «создать» и «переключиться» возможно
      // состояние «ветка создана, переключение упало», которое пришлось бы
      // отдельно описывать в ответе.
      const args = checkout ? ["checkout", "-b", name] : ["branch", name];
      if (from !== null) args.push(from);

      const res = await runGit(ctx, args);
      if (res.exitCode !== 0) {
        return failure(req, root, res, startedAt, { branch: name, from, checkout });
      }

      const head = await runGit(ctx, ["rev-parse", `refs/heads/${name}`]);
      return ok(
        res,
        checkout
          ? `Ветка ${name} создана, HEAD переключён на неё.`
          : `Ветка ${name} создана. Текущая ветка не менялась — чтобы перейти, вызовите ` +
            `run_git с operation "checkout_branch" и name "${name}".`,
        {
          branch: name,
          from,
          checked_out: checkout,
          head: head.exitCode === 0 ? head.stdout.trim() || null : null,
        },
        { branch: name, from, checkout },
      );
    }

    case "checkout_branch": {
      const name = requireBranchName(req.name!, "name");

      // Предпроверка существования ветки — не только ради текста. Она же снимает
      // неоднозначность «ветка или файл» у git checkout: собственное сообщение
      // git о промахе («pathspec … did not match any file(s)») сбивает с толку.
      if (!(await branchExists(ctx, name))) {
        throw new GitOpError(
          `ветка не найдена: ${name}. Существующие ветки покажет operation "branch_list", ` +
            `а создать новую можно операцией "branch_create".`,
        );
      }

      const previous = await currentBranch(ctx);
      const res = await runGit(ctx, ["checkout", name]);
      if (res.exitCode !== 0) {
        return failure(req, root, res, startedAt, { branch: name, previous_branch: previous });
      }

      return ok(
        res,
        previous === name
          ? `Уже были на ветке ${name}, ничего не изменилось.`
          : `Переключились на ветку ${name} (была ${previous ?? "detached HEAD"}).`,
        { branch: name, previous_branch: previous, already_on_branch: previous === name },
        { branch: name, previous_branch: previous },
      );
    }

    case "add_commit": {
      const message = req.message!;
      if (message.trim().length === 0) {
        throw new GitOpError(
          `сообщение коммита пустое. Передайте в message осмысленный текст — ` +
            `он попадёт в историю репозитория как есть.`,
        );
      }

      const pathspecs = req.paths!.map((p) => toPathspec(req, p));
      const logBase = { path_count: pathspecs.length };

      const added = await runGit(ctx, ["add", "--", ...pathspecs]);
      if (added.exitCode !== 0) return failure(req, root, added, startedAt, logBase);

      // Сообщение уходит через stdin, а не аргументом: кавычки, $( ), backtick и
      // ; внутри него не интерпретируются никем — stdin вообще не argv.
      // --cleanup не передаём: дефолт для -F срезает лишь хвостовые пробелы и
      // пустые строки, а строки с # не трогает, так что «fix #123» доезжает.
      const committed = await runGit(ctx, ["commit", "-F", "-"], message);
      if (committed.exitCode !== 0) {
        return failure(req, root, committed, startedAt, logBase);
      }

      const shown = await runGit(ctx, [
        "show",
        "--quiet",
        `--format=${COMMIT_FORMAT}`,
        "HEAD",
      ]);
      const commit = shown.exitCode === 0 ? (parseCommits(shown.stdout)[0] ?? null) : null;

      // --root обязателен: без него первый коммит репозитория (у него нет
      // родителя) дал бы пустой список файлов.
      const tree = await runGit(ctx, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "--name-status",
        "-z",
        "HEAD",
      ]);
      const files = tree.exitCode === 0 ? parseNameStatus(tree.stdout) : [];

      return ok(
        committed,
        `Коммит ${commit?.short_hash ?? "создан"}: файлов в коммите ${files.length}. ` +
          `Учтите, что git коммитит весь индекс: если в нём уже были застейджены другие ` +
          `изменения, они тоже вошли в коммит — фактический состав см. в files.`,
        {
          commit,
          files,
          staged_paths: pathspecs,
          files_count: files.length,
        },
        {
          ...logBase,
          files_count: files.length,
          commit: commit?.hash ?? null,
        },
      );
    }
  }
}
