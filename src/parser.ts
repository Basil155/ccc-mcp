/**
 * Разбор итогового отчёта claude: строки `type:"result"` из `--output-format
 * stream-json` (режим по умолчанию, `streamEvents: true`) либо единственного
 * объекта `--output-format json` (`streamEvents: false`). Обе формы идентичны
 * по полям, поэтому разбор один — раннер в стрим-режиме отдаёт сюда ровно
 * найденную им строку result.
 *
 * Схема CLI дрейфует между версиями: между 2.1.177 и 2.1.268 сменился порядок
 * полей и добавились новые (usage.output_tokens_details, subagent_stats,
 * fast_mode_disabled_reason). Поэтому строгой валидации здесь нет — мягко
 * забираем нужные поля по имени, всё остальное отдаём в `raw`.
 */

export interface ParsedResult {
  ok: boolean;
  sessionId: string | null;
  resultText: string | null;
  /** В ответе есть раздел «Открытые вопросы» — модели не хватило информации. */
  hasOpenQuestions: boolean;
  isError: boolean | null;
  subtype: string | null;
  apiErrorStatus: number | null;
  terminalReason: string | null;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  permissionDenials: unknown[];
  /**
   * Модели, которые реально отработали (из modelUsage), самая «рабочая» первой.
   * Алиасы здесь уже развёрнуты. Кроме основной модели сюда попадают служебные.
   */
  modelsUsed: string[];
  /** Подсказка человеку, когда ошибка распознана. */
  hint: string | null;
  /** Текст ошибки разбора, если JSON получить не удалось. */
  parseError: string | null;
  raw: Record<string, unknown> | null;
}

const MAX_TAIL = 4096;

/**
 * Распознаёт раздел с открытыми вопросами в тексте ответа.
 *
 * Допускаем разумный разброс оформления: любой уровень заголовка, жирный
 * вариант без решёток, двоеточие в конце, английский вариант. Заголовок должен
 * стоять отдельной строкой — иначе упоминание «в разделе Открытые вопросы»
 * внутри обычного абзаца давало бы ложное срабатывание.
 */
const OPEN_QUESTIONS_PATTERN =
  /^[ \t]*(?:#{1,6}[ \t]*|\*\*[ \t]*)(?:открытые[ \t]+вопросы|open[ \t]+questions)[ \t]*:?[ \t]*\*{0,2}[ \t]*$/im;

export function detectOpenQuestions(text: string | null | undefined): boolean {
  if (!text) return false;
  return OPEN_QUESTIONS_PATTERN.test(text);
}

/** Последние N символов — чтобы не раздувать ответ гигантским выводом. */
export function tail(text: string, limit = MAX_TAIL): string {
  if (text.length <= limit) return text;
  return `…(обрезано, показаны последние ${limit} символов)\n` + text.slice(-limit);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function isResultObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>)["type"] === "result"
  );
}

/**
 * Достаёт объект результата из stdout.
 *
 * Сначала пробуем разобрать весь вывод целиком (нормальный случай), затем —
 * построчно с конца, на случай если CLI напечатал что-то перед JSON.
 */
function extractJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isResultObject(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Падаем в построчный разбор ниже.
  }

  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isResultObject(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/** Превращает известные сообщения CLI в понятную инструкцию. */
function buildHint(resultText: string | null, apiErrorStatus: number | null): string | null {
  const text = resultText ?? "";

  if (/not logged in/i.test(text)) {
    return "Claude Code не авторизован. Выполните один раз в терминале: claude auth login";
  }
  if (/invalid api key/i.test(text) || apiErrorStatus === 401) {
    return (
      "Дочерний claude получил невалидный ключ. Обычно это значит, что в окружение " +
      "просочился ANTHROPIC_API_KEY родительского процесса — проверьте passEnv в конфиге. " +
      "Если ключ не нужен, выполните claude auth login."
    );
  }
  if (apiErrorStatus === 429) {
    return "Превышен лимит запросов к API. Повторите позже.";
  }
  // Невалидная или недоступная модель: CLI падает так же быстро и до расхода токенов.
  if (apiErrorStatus === 404 || /issue with the selected model/i.test(text)) {
    return (
      "Модель недоступна или не существует. Проверьте параметр model вызова " +
      "либо поле model в конфиге моста."
    );
  }
  return null;
}

/**
 * Модели из modelUsage, самая «рабочая» первой.
 *
 * В modelUsage попадает не только основная модель: CLI отдельно дёргает дешёвую
 * (генерация заголовка сессии и подобное), и её запись стоит рядом. Сортируем по
 * costUSD — на прогоне «sonnet + служебный haiku» это 0.0577 против 0.00098,
 * разница в полсотни раз.
 *
 * Считать по токенам нельзя: у основной модели вход почти весь уходит в кэш
 * (2 инпут-токена против 18531 cacheRead), и по «сырым» полям она проигрывает
 * служебной. Стоимость такой перекос уже учитывает.
 */
function extractModelsUsed(raw: Record<string, unknown>): string[] {
  const usage = raw["modelUsage"];
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return [];

  const cost = (entry: unknown): number => {
    if (typeof entry !== "object" || entry === null) return 0;
    return asNumber((entry as Record<string, unknown>)["costUSD"]) ?? 0;
  };

  return Object.entries(usage as Record<string, unknown>)
    .sort(([, a], [, b]) => cost(b) - cost(a))
    .map(([name]) => name);
}

export interface ParseInput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Процесс был убит по таймауту или через cancel_task. */
  killed?: boolean;
}

export function parseClaudeOutput(input: ParseInput): ParsedResult {
  const { stdout, stderr, exitCode, killed = false } = input;
  const raw = extractJson(stdout);

  if (!raw) {
    const detail = [
      stderr.trim() ? `stderr:\n${tail(stderr.trim())}` : null,
      stdout.trim() ? `stdout:\n${tail(stdout.trim())}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      ok: false,
      sessionId: null,
      resultText: null,
      hasOpenQuestions: false,
      isError: null,
      subtype: null,
      apiErrorStatus: null,
      terminalReason: null,
      numTurns: null,
      durationMs: null,
      totalCostUsd: null,
      permissionDenials: [],
      modelsUsed: [],
      hint: killed
        ? "Процесс был остановлен, поэтому JSON-отчёт не сформирован."
        : "Claude Code не вернул разбираемый итоговый JSON. Проверьте, что он авторизован " +
          "(claude auth login). По умолчанию мост просит поток событий " +
          '(--output-format stream-json --verbose) и берёт из него строку type:"result"; ' +
          "если разбор потока пошёл не так, поставьте streamEvents: false в конфиге — тогда " +
          "мост вернётся к простому --output-format json.",
      parseError:
        `не удалось получить JSON из вывода claude (exit code ${exitCode ?? "n/a"})` +
        (detail ? `\n\n${detail}` : ""),
      raw: null,
    };
  }

  const resultText = asString(raw["result"]);
  const isError = asBool(raw["is_error"]);
  const apiErrorStatus = asNumber(raw["api_error_status"]);
  const terminalReason = asString(raw["terminal_reason"]);

  // На subtype полагаться нельзя: оба наблюдённых провала (401 и "Not logged in")
  // приходили с subtype:"success". Считаем по is_error + exit code + terminal_reason.
  const ok =
    !killed &&
    isError !== true &&
    (exitCode === 0 || exitCode === null) &&
    terminalReason !== "api_error";

  return {
    ok,
    sessionId: asString(raw["session_id"]),
    resultText,
    hasOpenQuestions: detectOpenQuestions(resultText),
    isError,
    subtype: asString(raw["subtype"]),
    apiErrorStatus,
    terminalReason,
    numTurns: asNumber(raw["num_turns"]),
    durationMs: asNumber(raw["duration_ms"]),
    totalCostUsd: asNumber(raw["total_cost_usd"]),
    permissionDenials: Array.isArray(raw["permission_denials"])
      ? (raw["permission_denials"] as unknown[])
      : [],
    modelsUsed: extractModelsUsed(raw),
    hint: ok ? null : buildHint(resultText, apiErrorStatus),
    parseError: null,
    raw,
  };
}
