import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));

export const ConfigSchema = z.object({
  /** Белый список корней. Любой project_dir должен лежать внутри одного из них. */
  allowedRoots: z.array(z.string().min(1)).min(1),
  /** Путь к бинарю claude либо имя для поиска в PATH. */
  claudeBin: z.string().min(1).default("claude"),
  /**
   * Путь к бинарю git либо имя для поиска в PATH.
   *
   * Дефолт «git» обычно работает: /usr/bin/git попадает даже в урезанный PATH,
   * который Claude Desktop даёт серверу на macOS. Но ручка нужна по той же
   * причине, что и claudeBin: при промахе PATH инструмент иначе неисправим.
   */
  gitBin: z.string().min(1).default("git"),
  /**
   * Модель для дочернего claude. Пусто — решает сам CLI по своим настройкам.
   *
   * Задавайте явно, если глобальная модель в ~/.claude/settings.json недоступна
   * headless-режиму: такой вызов падает с 403 ещё до начала работы.
   */
  model: z.string().min(1).optional(),
  /** Таймаут на зависший процесс, мс. По умолчанию 30 минут. */
  timeoutMs: z.number().int().positive().default(30 * 60 * 1000),
  /** Сколько секунд инструмент ждёт результата, прежде чем уйти в async. */
  defaultWaitSeconds: z.number().int().min(0).max(120).default(20),
  /** Сколько процессов claude разрешено держать одновременно. */
  maxConcurrent: z.number().int().positive().default(3),
  /** Передавать ли --sandbox: auto — только если CLI его поддерживает. */
  sandbox: z.enum(["auto", "on", "off"]).default("auto"),
  /** Имена переменных окружения, которые пропускаем несмотря на чистку. */
  passEnv: z.array(z.string().min(1)).default([]),
  /** Файл JSONL-лога. */
  logFile: z.string().min(1).default("./logs/ccc-mcp.jsonl"),
  /** Сколько символов текста задачи попадает в лог. */
  logTaskTextChars: z.number().int().min(0).default(200),
  /** Писать ли в лог тело отчёта Claude Code. */
  logResultText: z.boolean().default(false),
  /**
   * Писать ли в лог периодическую сводку живого состояния задачи.
   *
   * Это телеметрия, а не аудит: счётчики и имена инструментов, без текста
   * модели и выжимок вызовов. Дефолт false — для разбора одной задачи хватает
   * сводки в записи finish/cancel, которая пишется всегда.
   */
  logProgress: z.boolean().default(false),
  /**
   * Не чаще одной записи прогресса в этот интервал на задачу, мс.
   *
   * Событий у дочернего CLI десятки в секунду, поэтому логируется не событие, а
   * состояние по времени: для 40-минутного прогона это ~40 строк.
   */
  logProgressIntervalMs: z.number().int().positive().default(60_000),
  /**
   * Предел размера файла для read_project_file / write_project_file, байт.
   *
   * Один лимит на чтение и запись: асимметрия породила бы файл, который можно
   * записать, но нельзя прочитать обратно. 512 KiB — это уже больше 150k токенов,
   * то есть далеко за пределом разумного для «покажи файл агенту».
   */
  maxFileBytes: z.number().int().positive().default(512 * 1024),
  /**
   * Предел числа записей в ответе list_project_files.
   *
   * 2000 записей — примерно 250 KB JSON, то есть меньше половины maxFileBytes:
   * бюджеты двух файловых сценариев согласованы. При этом типичный репозиторий
   * за вычетом игнор-листа укладывается в него целиком, и режется только
   * патология. Превышение — не ошибка, а частичный ответ с truncated: true.
   */
  maxListEntries: z.number().int().positive().default(2000),
  /**
   * Предел объёма вывода одной git-операции, байт. Актуален прежде всего для diff.
   *
   * Отдельно от maxFileBytes: тот про один файл, а дифф ветки бывает больше на
   * порядок. При этом, в отличие от чтения файла, превышение здесь не ошибка, а
   * частичный ответ с truncated: true — оборванный патч всё равно показывает,
   * что происходит.
   */
  maxDiffBytes: z.number().int().positive().default(256 * 1024),
  /**
   * Таймаут одной git-операции, мс.
   *
   * Две минуты, а не секунды: git commit запускает pre-commit хуки репозитория,
   * которые вполне могут линтовать проект целиком. Хуки мы не отключаем —
   * их отказ это осмысленный результат, а не сбой моста.
   */
  gitTimeoutMs: z.number().int().positive().default(2 * 60 * 1000),
  /** Сколько держать завершённые задачи в памяти, мс. */
  jobRetentionMs: z.number().int().positive().default(60 * 60 * 1000),
  /** Сколько живёт состояние сессии (план/одобрение), мс. По умолчанию сутки. */
  sessionRetentionMs: z.number().int().positive().default(24 * 60 * 60 * 1000),

  /**
   * Запускать дочерний CLI в режиме --output-format stream-json --verbose и
   * разбирать поток событий по мере поступления.
   *
   * Выключите, если дочерний CLI перестал отдавать разбираемый stream-json: с
   * false мост возвращается к --output-format json и разбору одним куском, а
   * живое состояние задачи становится пустым. Ни одно поле отчёта при этом не
   * меняет смысла — финальная строка result в обоих режимах одна и та же, и
   * разбирает её один и тот же parseClaudeOutput.
   */
  streamEvents: z.boolean().default(true),

  /**
   * Контроль чувствительных операций дочернего CLI через PreToolUse-хуки.
   *
   * Механизм опирается на то, что модель повторит отклонённый вызов после
   * одобрения. Вручную проверено на macOS + CLI 2.1.268: повтор побайтовый,
   * окончательный deny прекращает попытки.
   *
   * Дефолт всё равно false — он распространяется и на непроверенные платформы
   * (Windows), а включается опт-ин дешёвым: поле в конфиге либо
   * CCC_HOOKS_ENABLED=1.
   */
  hooksEnabled: z.boolean().default(false),
  /** Инструменты дочернего CLI, требующие одобрения оператора. */
  sensitiveTools: z.array(z.string().min(1)).default(["Bash", "Write", "Edit"]),
  /**
   * Сколько раз один и тот же запрос может получить отказ, прежде чем
   * запрещается навсегда в рамках этой задачи.
   *
   * Fail-closed: исчерпание бюджета даёт вечный deny, а не allow. Иначе модель
   * могла бы «продавить» любое разрешение, просто продолжая пытаться.
   */
  retryBudget: z.number().int().min(1).max(100).default(10),
  /** Предел числа различных запросов на разрешение в одной задаче. */
  maxPendingRequests: z.number().int().min(1).max(500).default(50),
  /**
   * Разрешать `sleep N` (N ≤ 60) без одобрения.
   *
   * Это разрешение моста, а не гарантия доступности: харнесс дочернего CLI
   * может запретить `sleep` в Bash самостоятельно, и тогда модель ждёт решения
   * оператора другим способом — подсказка хука конкретного примитива не
   * навязывает.
   */
  allowWaitCommand: z.boolean().default(true),
  /**
   * Команды Bash, которые мост пропускает без одобрения оператора.
   *
   * Каждая строка — команда целиком: сравнение посимвольное по всей строке
   * (после trim с обеих сторон), без префиксов, шаблонов и регулярных выражений.
   * «npm run typecheck && rm -rf /» под «npm run typecheck» не подпадает.
   *
   * Дефолт пуст: механизм включается только явным списком. Семантику команд мост
   * не проверяет — что сюда класть, решает оператор. Разумное правило: только
   * детерминированные проверки, не тратящие деньги и не ходящие в сеть
   * («npm run typecheck», «npm run build», «git status --porcelain»).
   * «npm run smoke» без --no-live под правило не подходит: он порождает дочерние
   * процессы claude, то есть жжёт токены.
   */
  autoApproveCommands: z.array(z.string().min(1)).default([]),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface Config extends RawConfig {
  /** allowedRoots после realpath — именно с ними сравнивается project_dir. */
  resolvedRoots: string[];
  /** Абсолютный путь лога. */
  resolvedLogFile: string;
  /** Откуда конфиг прочитан (для диагностики). */
  source: string;
}

export class ConfigError extends Error {}

/** Путь к конфигу: env CCC_MCP_CONFIG, иначе ccc-mcp.config.json рядом с сервером. */
function locateConfigFile(): string | null {
  const fromEnv = process.env["CCC_MCP_CONFIG"];
  if (fromEnv && fromEnv.trim()) {
    const p = resolve(fromEnv.trim());
    if (!existsSync(p)) {
      throw new ConfigError(
        `CCC_MCP_CONFIG указывает на несуществующий файл: ${p}`,
      );
    }
    return p;
  }

  // dist/config.js -> корень пакета на уровень выше.
  for (const candidate of [
    resolve(here, "..", "ccc-mcp.config.json"),
    resolve(process.cwd(), "ccc-mcp.config.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function splitList(value: string): string[] {
  // Разделитель — только ';': Windows-пути содержат ':', а команды — пробелы и запятые.
  return value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Переменные окружения перекрывают значения из файла. */
function applyEnvOverrides(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };

  const roots = process.env["CCC_ALLOWED_ROOTS"];
  if (roots && roots.trim()) out["allowedRoots"] = splitList(roots);

  const bin = process.env["CCC_CLAUDE_BIN"];
  if (bin && bin.trim()) out["claudeBin"] = bin.trim();

  const git = process.env["CCC_GIT_BIN"];
  if (git && git.trim()) out["gitBin"] = git.trim();

  const model = process.env["CCC_MODEL"];
  if (model && model.trim()) out["model"] = model.trim();

  const timeout = process.env["CCC_TIMEOUT_MS"];
  if (timeout && timeout.trim()) {
    const n = Number(timeout);
    if (!Number.isFinite(n)) {
      throw new ConfigError(`CCC_TIMEOUT_MS не число: ${timeout}`);
    }
    out["timeoutMs"] = n;
  }

  const log = process.env["CCC_LOG_FILE"];
  if (log && log.trim()) out["logFile"] = log.trim();

  const hooks = process.env["CCC_HOOKS_ENABLED"];
  if (hooks && hooks.trim()) {
    const v = hooks.trim().toLowerCase();
    if (v === "1" || v === "true") out["hooksEnabled"] = true;
    else if (v === "0" || v === "false") out["hooksEnabled"] = false;
    else throw new ConfigError(`CCC_HOOKS_ENABLED должен быть 1/0/true/false, получено: ${hooks}`);
  }

  const autoApprove = process.env["CCC_AUTO_APPROVE_COMMANDS"];
  if (autoApprove && autoApprove.trim()) out["autoApproveCommands"] = splitList(autoApprove);

  const stream = process.env["CCC_STREAM_EVENTS"];
  if (stream && stream.trim()) {
    const v = stream.trim().toLowerCase();
    if (v === "1" || v === "true") out["streamEvents"] = true;
    else if (v === "0" || v === "false") out["streamEvents"] = false;
    else throw new ConfigError(`CCC_STREAM_EVENTS должен быть 1/0/true/false, получено: ${stream}`);
  }

  return out;
}

export function loadConfig(): Config {
  const file = locateConfigFile();

  let raw: Record<string, unknown> = {};
  let source = "переменные окружения";

  if (file) {
    source = file;
    let text: string;
    try {
      // Читаем синхронно — это происходит один раз на старте.
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new ConfigError(`не удалось прочитать ${file}: ${String(err)}`);
    }
    try {
      raw = JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`${file} — невалидный JSON: ${String(err)}`);
    }
  }

  const merged = applyEnvOverrides(raw);
  const parsed = ConfigSchema.safeParse(merged);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(корень)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      `конфигурация невалидна (источник: ${source})\n${issues}\n\n` +
        `Укажите путь к конфигу через CCC_MCP_CONFIG или задайте CCC_ALLOWED_ROOTS. ` +
        `Образец — ccc-mcp.config.example.json.`,
    );
  }

  const cfg = parsed.data;

  // Fail-closed: без валидного белого списка сервер не стартует.
  const resolvedRoots: string[] = [];
  for (const root of cfg.allowedRoots) {
    if (!isAbsolute(root)) {
      throw new ConfigError(`allowedRoots: путь должен быть абсолютным: ${root}`);
    }
    if (!existsSync(root)) {
      throw new ConfigError(`allowedRoots: каталог не существует: ${root}`);
    }
    try {
      resolvedRoots.push(realpathSync.native(root));
    } catch (err) {
      throw new ConfigError(`allowedRoots: не удалось разрешить ${root}: ${String(err)}`);
    }
  }

  const base = file ? dirname(file) : process.cwd();
  const resolvedLogFile = isAbsolute(cfg.logFile)
    ? cfg.logFile
    : resolve(base, cfg.logFile);

  return { ...cfg, resolvedRoots, resolvedLogFile, source };
}

/** Разрешаем // и /* *\/ комментарии в конфиге — так удобнее его править руками. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Экранированный символ копируем целиком, чтобы не спутать \" с концом строки.
        const escaped = text[i + 1];
        if (escaped !== undefined) {
          out += escaped;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
