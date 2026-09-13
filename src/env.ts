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
