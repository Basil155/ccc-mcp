import type { ProgressSnapshot } from "./progress.js";

/**
 * Живое состояние задачи в виде, пригодном для отчёта, лога и подсказки.
 *
 * Снимок JobProgress — внутренняя структура: camelCase, время в миллисекундах,
 * два десятка полей, часть из которых нужна только детектору паттернов. Наружу
 * идёт не он, а отобранный и переведённый в формат отчёта вид: snake_case и ISO,
 * как у permission_requests, и только то, по чему вызывающий агент способен
 * принять решение.
 *
 * Три вещи, которые снимок знает, а наружу сознательно не идут:
 *
 * - startedAt/finishedAt — их уже несут elapsed_ms и duration_ms отчёта;
 * - segments/resultEvents — механика сегментов внутри одного процесса CLI,
 *   действовать по ней нельзя;
 * - repeatedCalls — карта непрозрачных отпечатков. Сам факт хождения по кругу
 *   выдаётся паттерном repeated_tool_call человеческой фразой, а сырая карта
 *   заставляла бы вызывающего считать пороги самостоятельно.
 *
 * Модуль чистый: только типы на входе, никаких часов, логгера и конфига. Это
 * позволяет smoke гонять его на снимках из фикстур — dist/index.js
 * импортировать нельзя, он стартует сервер прямо на импорте.
 */

/** Сколько имён инструментов перечисляем в подсказке об остановленной задаче. */
const HINT_TOOLS_LISTED = 3;
/** Длина среза последнего сообщения модели в подсказке. */
const HINT_TEXT_CHARS = 160;

export interface ToolCallView {
  name: string;
  /** Выжимка ввода, та же, что видит оператор в запросе на разрешение. */
  summary: string;
  /** Совпадает с request_id в permission_requests: именно его одобряет оператор. */
  request_id: string;
  at: string | null;
  /** Пришёл ли tool_result. Отказ хука — тоже пришёл. */
  completed: boolean;
  /** is_error у tool_result. null — результата ещё не было. */
  is_error: boolean | null;
  /** Какой по счёту это вызов с теми же аргументами (1 — первый). */
  repeat: number;
}

export interface RateLimitViewOut {
  status: string;
  utilization: number | null;
  resets_at: string | null;
}

export interface RecentEventView {
  at: string | null;
  kind: string;
  text: string;
}

/**
 * Форма не мигает: все ключи присутствуют всегда.
 *
 * При streamEvents: false, ошибке спавна или молчащем CLI это нули, пустые
 * карты и null — но не отсутствующие поля и не null вместо всего объекта.
 */
export interface ProgressView {
  /** Пришла хотя бы одна строка потока. */
  streaming: boolean;
  /** У завершённой задачи заморожено на моменте конца, а не растёт дальше. */
  elapsed_ms: number;
  last_activity_at: string | null;
  /** Главный признак зависания — вместе с open_tool_calls. */
  idle_seconds: number | null;
  /** Запрошенная модель из system/init. Не то же, что model_used. */
  model: string | null;
  assistant_events: number;
  assistant_text_blocks: number;
  tool_calls: number;
  tool_results: number;
  /** tool_result с is_error — в основном отказы моста разрешений. */
  tool_errors: number;
  /** Вызовы без результата: «инструмент ещё работает», а не «задача зависла». */
  open_tool_calls: number;
  tools_used: Record<string, number>;
  last_tool_call: ToolCallView | null;
  /** Видимый текст модели. Рассуждения сюда не попадают по построению. */
  last_assistant_text: string | null;
  thinking_blocks: number;
  thinking_token_events: number;
  /** Оценка самого CLI, не наш расчёт по токенам. */
  estimated_thinking_tokens: number | null;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  rate_limit: RateLimitViewOut | null;
  recent_events: RecentEventView[];
  /**
   * total_cost_usd последней встреченной строки result — точное накопительное
   * число CLI, а не оценка по токенам: считать стоимость самостоятельно мост
   * по-прежнему не пытается. null означает «ни один сегмент ещё не завершился»
   * и не равно нулю. Итоговая стоимость задачи — по-прежнему total_cost_usd
   * отчёта, известный только по завершении.
   */
  last_result_cost_usd: number | null;
  bad_lines: number;
  oversize_lines: number;
  unknown_event_types: Record<string, number>;
}

/**
 * Миллисекунды эпохи в ISO.
 *
 * С защитой от невалидного значения: время приходит из события CLI, и
 * исключение RangeError в момент сборки отчёта стоило бы всего ответа.
 */
function isoFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** resetsAt приходит в unix-секундах, как в самом событии rate_limit. */
function isoFromSeconds(seconds: number | null): string | null {
  return seconds === null ? null : isoFromMs(seconds * 1000);
}

export function toProgressView(s: ProgressSnapshot): ProgressView {
  return {
    streaming: s.streaming,
    elapsed_ms: s.elapsedMs,
    last_activity_at: isoFromMs(s.lastActivityAt),
    idle_seconds: s.idleSeconds,
    model: s.model,
    assistant_events: s.assistantEvents,
    assistant_text_blocks: s.assistantTextBlocks,
    tool_calls: s.toolCalls,
    tool_results: s.toolResults,
    tool_errors: s.toolErrors,
    open_tool_calls: s.openToolCalls,
    tools_used: s.toolsUsed,
    last_tool_call:
      s.lastToolCall === null
        ? null
        : {
            name: s.lastToolCall.name,
            summary: s.lastToolCall.summary,
            request_id: s.lastToolCall.requestId,
            at: isoFromMs(s.lastToolCall.at),
            completed: s.lastToolCall.completed,
            is_error: s.lastToolCall.isError,
            repeat: s.lastToolCall.repeat,
          },
    last_assistant_text: s.lastAssistantText,
    thinking_blocks: s.thinkingBlocks,
    thinking_token_events: s.thinkingTokenEvents,
    estimated_thinking_tokens: s.estimatedThinkingTokens,
    cache_read_input_tokens: s.cacheReadInputTokens,
    cache_creation_input_tokens: s.cacheCreationInputTokens,
    rate_limit:
      s.rateLimit === null
        ? null
        : {
            status: s.rateLimit.status,
            utilization: s.rateLimit.utilization,
            resets_at: isoFromSeconds(s.rateLimit.resetsAt),
          },
    recent_events: s.recentEvents.map((e) => ({
      at: isoFromMs(e.at),
      kind: e.kind,
      text: e.text,
    })),
    last_result_cost_usd: s.lastResultCostUsd,
    bad_lines: s.badLines,
    oversize_lines: s.oversizeLines,
    unknown_event_types: s.unknownTypes,
  };
}

/**
 * Сводка живого состояния для JSONL-лога.
 *
 * Только счётчики и имена. Текста здесь нет намеренно: записи хуков — это
 * аудит авторизации, где содержимое операции и есть предмет записи, а записи
 * прогресса — телеметрия. Выжимка Bash-команды самое вероятное место для
 * секрета в argv, и писать её на каждую сводку значило бы расширить поверхность
 * утечки при нулевой пользе для аудита. Поэтому last_assistant_text,
 * last_tool_call.summary и recent_events сюда не попадают ни при каких флагах.
 */
export function progressLogFields(s: ProgressSnapshot): Record<string, unknown> {
  return {
    stream_active: s.streaming,
    // Из строки init: известен даже когда итогового отчёта нет вовсе, и именно
    // он делает отменённую задачу возобновляемой.
    stream_session_id: s.sessionId,
    stream_assistant_events: s.assistantEvents,
    stream_tool_calls: s.toolCalls,
    stream_tool_results: s.toolResults,
    stream_tool_errors: s.toolErrors,
    stream_open_tool_calls: s.openToolCalls,
    stream_tools_used: s.toolsUsed,
    stream_idle_seconds: s.idleSeconds,
    stream_bad_lines: s.badLines,
    stream_oversize_lines: s.oversizeLines,
    stream_unknown_types: s.unknownTypes,
  };
}

/** «4 мин 12 с» либо «45 с» — длительность словами, без дробей. */
function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} с`;
  return seconds === 0 ? `${minutes} мин` : `${minutes} мин ${seconds} с`;
}

/** «Read×12, Bash×3» — самые частые инструменты, не весь список. */
function describeTools(tools: Record<string, number>): string {
  const entries = Object.entries(tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = entries.slice(0, HINT_TOOLS_LISTED).map(([name, count]) => `${name}×${count}`);
  const rest = entries.length - head.length;
  return rest > 0 ? `${head.join(", ")} и ещё ${rest}` : head.join(", ");
}

function cut(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`;
}

/**
 * Подсказка для остановленной задачи: что успело произойти.
 *
 * Заменяет собой парсерное «Процесс был остановлен, поэтому JSON-отчёт не
 * сформирован» — формально верное, но не сообщающее ничего. Итоговый отчёт CLI
 * мы при этом не подделываем: result_text у отменённой задачи остаётся null
 * (из него выводятся plan_digest и has_open_questions), а частичное знание
 * живёт здесь и в progress.
 */
export function buildTerminalHint(input: {
  status: "timeout" | "canceled";
  snapshot: ProgressSnapshot;
  /** Успел ли CLI выдать разобранную строку result до остановки. */
  hasResultText: boolean;
  /** Уже разрешённый session_id отчёта: из result, из потока или запрошенный. */
  sessionId: string | null;
}): string {
  const { status, snapshot, hasResultText, sessionId } = input;
  const parts: string[] = [];

  parts.push(
    status === "timeout"
      ? `Задача прервана по таймауту через ${humanDuration(snapshot.elapsedMs)}.`
      : `Задача остановлена через ${humanDuration(snapshot.elapsedMs)}.`,
  );

  if (hasResultText) {
    // Убийство догнало нормальное завершение: отчёт CLI есть целиком, и
    // пересказывать вместо него счётчики было бы хуже, чем показать его.
    parts.push("Итоговый отчёт CLI всё же успел прийти — он в result_text.");
  } else if (!snapshot.streaming) {
    parts.push(
      "Живого состояния нет: поток событий выключен (streamEvents: false) либо дочерний " +
        "Claude Code не успел выдать ни одной строки. Судить о том, что он сделал, нечем — " +
        "смотрите stderr в логе.",
    );
  } else {
    const done: string[] = [];
    done.push(
      snapshot.toolCalls === 0
        ? "вызовов инструментов не было"
        : `вызовов инструментов ${snapshot.toolCalls} (${describeTools(snapshot.toolsUsed)})`,
    );
    const last = snapshot.lastToolCall;
    if (last !== null) {
      done.push(
        `последний — ${last.name} («${last.summary}»), ${
          last.completed ? "завершился" : "выполнялся на момент остановки"
        }`,
      );
    }
    done.push(`ходов ассистента ${snapshot.assistantEvents}`);
    if (snapshot.toolCalls === 0 && snapshot.thinkingTokenEvents > 0) {
      done.push(`пульсов размышления ${snapshot.thinkingTokenEvents}`);
    }
    parts.push(`Итогового отчёта CLI нет, но известно, что успело произойти: ${done.join(", ")}.`);

    if (snapshot.lastAssistantText !== null) {
      parts.push(`Последнее видимое сообщение: «${cut(snapshot.lastAssistantText, HINT_TEXT_CHARS)}».`);
    }
    parts.push("Подробности — в progress.recent_events.");
  }

  parts.push(
    sessionId === null
      ? "session_id получить не удалось, поэтому продолжить именно эту сессию не выйдет."
      : `session_id сохранён — работу можно продолжить, передав его в plan_task или execute_task.`,
  );

  return parts.join(" ");
}

/**
 * Подсказка, когда итогового JSON нет, а поток при этом сорил плохими строками.
 *
 * Комбинация «плохие строки были И строки result не случилось» — самый прямой
 * признак того, что формат stream-json дочернего CLI разошёлся с ожиданиями
 * моста. Это единственный случай, когда общая подсказка парсера уводит не туда:
 * она отправляет проверять авторизацию, а причина совсем другая.
 *
 * null, когда плохих строк не было: тогда парсерная подсказка верна и подменять
 * её нечем.
 */
export function buildStreamDriftHint(s: ProgressSnapshot): string | null {
  const bad = s.badLines + s.oversizeLines;
  if (bad === 0) return null;

  const what =
    s.oversizeLines === 0
      ? `неразобранных строк ${s.badLines}`
      : s.badLines === 0
        ? `строк сверх предела длины ${s.oversizeLines}`
        : `неразобранных строк ${s.badLines}, строк сверх предела длины ${s.oversizeLines}`;

  return (
    `Итогового отчёта Claude Code нет, и разбор потока событий шёл с ошибками: ${what}, ` +
    `разобранных событий ${s.assistantEvents + s.toolCalls}. Вероятнее всего формат ` +
    `stream-json дочернего CLI изменился. Обход — streamEvents: false в конфиге моста: ` +
    `тогда он просит у CLI один итоговый JSON вместо потока. Подробности по каждому случаю ` +
    `— записи stream_warn в JSONL-логе.`
  );
}
