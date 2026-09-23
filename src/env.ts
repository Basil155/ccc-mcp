/**
 * Чистка окружения для дочернего процесса `claude`.
 *
 * Родительский процесс (Claude Desktop / Claude Code) экспортирует свои
 * ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CODE_MESSAGING_TOKEN и др.
 * Если унаследовать их как есть, дочерний `claude` падает с
 * `{"is_error":true,"api_error_status":401,"result":"Invalid API key ..."}`.
 *
 * Поэтому вычищаем всё семейство переменных ANTHROPIC_ и CLAUDE_: дочерний процесс должен
 * пользоваться собственной аутентификацией (`claude auth login`), а ключ
 * родителя не должен доходить ни до него, ни до лога.
 */

import { spawnSync } from "node:child_process";

const DENY_PREFIX = /^(ANTHROPIC_|CLAUDE_)/i;
const DENY_EXACT = new Set(["CLAUDECODE"]);

/** Имена переменных, которые считаем секретами при редакции логов. */
export const SECRET_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

export interface ScrubResult {
  env: NodeJS.ProcessEnv;
  /** Имена удалённых переменных — только имена, без значений. */
  removed: string[];
}

/**
 * Возвращает копию окружения без переменных Anthropic/Claude.
 *
 * Денилист, а не аллоулист: на Windows дочернему процессу нужны PATH, USERPROFILE,
 * APPDATA, LOCALAPPDATA, TEMP, SystemRoot и десяток других переменных, и жёсткий
 * аллоулист ломает больше, чем защищает.
 *
 * @param passEnv имена, которые нужно пропустить несмотря на денилист.
 */
export function scrubEnv(
  source: NodeJS.ProcessEnv = process.env,
  passEnv: readonly string[] = [],
): ScrubResult {
  const keep = new Set(passEnv.map((n) => n.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;

    const upper = name.toUpperCase();
    const denied = DENY_PREFIX.test(name) || DENY_EXACT.has(upper);

    if (denied && !keep.has(upper)) {
      removed.push(name);
      continue;
    }
    env[name] = value;
  }

  return { env, removed };
}

/**
 * Метка окружения «этот процесс — потомок дочернего claude, запущенного мостом».
 *
 * Дочерний Claude Code поднимает свои MCP-серверы, и если ccc-mcp зарегистрирован
 * в пользовательском scope, среди них оказывается и сам мост. Такой вложенный мост
 * дал бы дочернему процессу plan_task/execute_task (запуск следующих claude и
 * одобрение собственных планов), а также run_git и write_project_file, которые
 * работают мимо хуков разрешений. Поэтому мост, увидевший метку, не стартует.
 *
 * Не ANTHROPIC_/CLAUDE_: scrubEnv её не трогает, и она доходит до всех потомков,
 * а не только до непосредственного ребёнка.
 */
export const NESTED_ENV_VAR = "CCC_MCP_NESTED";

/** Ставит метку вложенности в окружение дочернего claude. */
export function markNested(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  env[NESTED_ENV_VAR] = "1";
  return env;
}

/** Запущен ли процесс внутри дочернего claude моста. Пустое значение не считается. */
export function isNested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[NESTED_ENV_VAR];
  return typeof v === "string" && v.trim() !== "";
}

/**
 * PATH для дочернего процесса на Windows — заново из реестра, а не от родителя.
 *
 * Claude Desktop отдаёт MCP-серверу PATH со своими добавками, поэтому собираем
 * PATH так, как его получил бы процесс, запущенный из проводника: HKLM, затем
 * HKCU. Исключение — каталог MSIX-пакета PowerShell 7, см. keepPwshPackageDir.
 *
 * Поломку Bash (снимок шелла с Windows-PATH без /usr/bin), которую когда-то
 * приписали PATH от Desktop, пересборка PATH не лечит: на CLI 2.1.274 она
 * проявляется непостоянно и при PATH из реестра, причина не установлена.
 */
export interface ChildPathResult {
  /** Новый PATH; null — оставить унаследованный. */
  path: string | null;
  /** Элементы родительского PATH, которых нет в собранном. */
  dropped: string[];
  /** Причина, по которой PATH оставлен как есть. */
  error: string | null;
}

/** Раскрывает %VAR% по окружению без учёта регистра имён. Неизвестные оставляет как есть. */
export function expandWindowsVars(value: string, source: NodeJS.ProcessEnv): string {
  const lookup = new Map<string, string>();
  for (const [name, v] of Object.entries(source)) {
    if (v !== undefined) lookup.set(name.toUpperCase(), v);
  }
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole);
}

/** Склеивает машинный и пользовательский PATH: пустые элементы и повторы убираются. */
export function joinWindowsPath(parts: readonly string[], source: NodeJS.ProcessEnv): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const raw of expandWindowsVars(part, source).split(";")) {
      const entry = raw.trim();
      if (!entry) continue;
      const key = entry.replace(/\\+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out.join(";");
}

/** Элементы inherited, отсутствующие в rebuilt (сравнение без регистра и хвостового «\»). */
export function diffWindowsPath(inherited: string, rebuilt: string): string[] {
  const norm = (e: string) => e.trim().replace(/\\+$/, "").toLowerCase();
  const kept = new Set(rebuilt.split(";").map(norm));
  return inherited
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e && !kept.has(norm(e)));
}

/** Каталог MSIX-пакета PowerShell 7: C:\Program Files\WindowsApps\Microsoft.PowerShell_…\ */
const PWSH_PACKAGE_DIR = /\\WindowsApps\\Microsoft\.PowerShell(?:Preview)?_[^\\;]+\\?$/i;

/**
 * Ставит каталог MSIX-пакета PowerShell из родительского PATH в начало собранного.
 *
 * PowerShell 7 из Microsoft Store в PATH реестра не попадает: его каталог
 * добавляет в PATH сам Desktop. Без него Claude Code находит только алиас
 * %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe, а разбор синтаксиса команды
 * через алиас падает («pwsh exited with code 1: Слишком длинная командная
 * строка»), и каждый вызов PowerShell без готового правила разрешения
 * отклоняется. Каталог нужен именно в начале: в конце PATH раньше него
 * находится тот же алиас. Проверено на CLI 2.1.274.
 */
export function keepPwshPackageDir(inherited: string, rebuilt: string): string {
  const norm = (e: string) => e.trim().replace(/\\+$/, "").toLowerCase();
  const have = new Set(rebuilt.split(";").map(norm));
  const pwshDirs = inherited
    .split(";")
    .map((e) => e.trim())
    .filter((e) => PWSH_PACKAGE_DIR.test(e) && !have.has(norm(e)));
  return pwshDirs.length ? [...pwshDirs, rebuilt].join(";") : rebuilt;
}

/** Имя ключа PATH в окружении как оно есть («Path» на Windows), либо «PATH». */
export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * Читает машинный и пользовательский PATH из реестра через Windows PowerShell.
 *
 * Не reg.exe: его вывод идёт в OEM-кодировке и портит кириллические пути.
 * Не pwsh: он может быть не установлен, а powershell.exe есть в любой Windows.
 * .NET раскрывает REG_EXPAND_SZ сам; expandWindowsVars — страховка.
 */
export function buildChildPathFromRegistry(source: NodeJS.ProcessEnv = process.env): ChildPathResult {
  const systemRoot = source["SystemRoot"] ?? source["SYSTEMROOT"] ?? "C:\\Windows";
  const exe = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "[Environment]::GetEnvironmentVariable('Path','Machine');" +
    "'<<ccc-mcp>>';" +
    "[Environment]::GetEnvironmentVariable('Path','User')";
  const res = spawnSync(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });
  if (res.error || res.status !== 0) {
    const why = res.error ? res.error.message : `код выхода ${res.status}: ${(res.stderr ?? "").trim()}`;
    return { path: null, dropped: [], error: `не удалось прочитать PATH из реестра (${why})` };
  }
  const [machine = "", user = ""] = (res.stdout ?? "").split("<<ccc-mcp>>").map((s) => s.trim());
  const registryPath = joinWindowsPath([machine, user], source);
  if (!registryPath) {
    return { path: null, dropped: [], error: "PATH в реестре пуст" };
  }
  const inherited = source[pathKey(source)] ?? "";
  const path = keepPwshPackageDir(inherited, registryPath);
  return { path, dropped: diffWindowsPath(inherited, path), error: null };
}
