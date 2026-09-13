import { computeRequestId, summarizeToolInput } from "./hookBridge.js";
import { preview } from "./logger.js";
import type { BadLineReason, StreamEvent } from "./stream.js";

/**
 * Живое состояние выполняющейся задачи, собранное по событиям stream-json.
 *
 * Пока задача идёт, единственное, что о ней известно снаружи, — это status
 * "running". Этот класс превращает поток NDJSON в набор счётчиков, по которым
 * видно, что происходит: какие инструменты вызывались, чем кончился последний
 * вызов, не повторяет ли модель одно и то же, когда была последняя активность.
 *
 * Три свойства, вытекающие из снятых фикстур (scripts/fixtures/README.md), а не
 * из общих соображений:
 *
 * 1. num_turns из строки result НЕ считается ходами задачи: он посегментный и
 *    обнуляется на каждом новом init (в stream-denied-retry — 8, 3, 2). Ходы и
 *    вызовы инструментов считаются здесь самостоятельно, по событиям.
 * 2. Строка result НЕ обнуляет состояние. Внутри одного процесса CLI пар
 *    init → result бывает несколько (фоновые задачи начинают новый сегмент), и
 *    сброс ровно между попытками уничтожил бы счётчик повторов: в той же
 *    фикстуре три вызова с одним request_id лежат в трёх разных сегментах.
 * 3. Отклонённый хуком вызов — ЗАВЕРШЁННЫЙ вызов. Отказ приходит как
 *    tool_result с is_error: true через 3–29 мс после tool_use, поэтому
 *    completed у него true, а неуспешность видна по отдельному флагу isError.
 *    Иначе детектор зависаний срабатывал бы на каждом отказе хука.
 *
 * Содержимое наружу не выносится: тела tool_result (файлы, вывод команд, текст
 * отказа моста) не читаются вообще, блоки thinking учитываются только счётчиком.
 * Единственная выжимка ввода — summarizeToolInput, та же, что видит оператор в
 * запросе на разрешение.
 */

/** Сколько разных имён инструментов держим в tools_used. */
const MAX_TOOLS_TRACKED = 50;
/** Сколько отпечатков вызовов держим в счётчике повторов. */
const MAX_REPEAT_KEYS = 200;
/** Сколько message.id помним, чтобы не посчитать usage дважды. */
const MAX_MESSAGE_IDS = 200;
/** Сколько незакрытых вызовов инструментов отслеживаем одновременно. */
const MAX_OPEN_CALLS = 50;
/** Сколько разных незнакомых типов событий помним. */
const MAX_UNKNOWN_TYPES = 20;
/** Длина кольца последних событий. */
const MAX_RECENT_EVENTS = 20;
/** Предел на текст одной записи кольца. */
const RECENT_EVENT_CHARS = 200;
/** Предел на последнее видимое сообщение ассистента. */
const MAX_ASSISTANT_TEXT_CHARS = 600;

/**
 * Итого на задачу: ≤50 имён инструментов, ≤200 отпечатков, ≤200 message.id,
 * ≤50 незакрытых вызовов, ≤20 типов, кольцо 20×≤200 символов и один срез текста
 * ≤600 символов — порядка 20 КБ. При MAX_FINISHED = 100 в JobRegistry это
 * потолок ~2 МБ на весь сервер.
 */

export interface ToolCallSummary {
  name: string;
  /** Выжимка ввода через summarizeToolInput; сырой tool_input наружу не идёт. */
  summary: string;
  toolUseId: string | null;
  /** Тот же computeRequestId, что у моста разрешений: id, который одобряет оператор. */
  requestId: string;
  at: number;
  /** Пришёл ли tool_result. Отказ хука — тоже пришёл. */
  completed: boolean;
  /** is_error у tool_result. null — результата ещё не было. */
  isError: boolean | null;
  /** Какой по счёту это вызов с тем же requestId (1 — первый). */
  repeat: number;
}

export interface RateLimitView {
  status: string;
  utilization: number | null;
  /** Unix-секунды, как в самом событии. */
  resetsAt: number | null;
}

export interface RecentEvent {
  at: number;
  kind: string;
  text: string;
}

export interface ProgressSnapshot {
  /** Пришла хотя бы одна строка — событие или непарсящаяся. */
  streaming: boolean;
  /** Из system/init: известен через секунду после спавна, а не в конце прогона. */
  sessionId: string | null;
  /** Из system/init: запрошенная модель, НЕ model_used из modelUsage. */
  model: string | null;
  startedAt: number;
  finishedAt: number | null;
  elapsedMs: number;
  lastActivityAt: number | null;
  idleSeconds: number | null;
  /** Число строк system/init: сегментов внутри одного процесса бывает несколько. */
  segments: number;
  resultEvents: number;
  assistantEvents: number;
  assistantTextBlocks: number;
  toolCalls: number;
  toolResults: number;
  /** tool_result с is_error: true — в основном отказы моста разрешений. */
  toolErrors: number;
  /** Вызовы без tool_result: «инструмент ещё работает», а не «задача зависла». */
  openToolCalls: number;
  toolsUsed: Record<string, number>;
  lastToolCall: ToolCallSummary | null;
  /** Только видимый текст модели, ≤600 символов. Рассуждения не показываются. */
  lastAssistantText: string | null;
  thinkingBlocks: number;
  thinkingTokenEvents: number;
  /** Оценка самого CLI из system/thinking_tokens, не наш расчёт. */
  estimatedThinkingTokens: number | null;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  rateLimit: RateLimitView | null;
  recentEvents: RecentEvent[];
  repeatedCalls: Record<string, number>;
  /**
   * total_cost_usd последней встреченной строки result.
   *
   * Это точное число CLI, накопительное по всем сегментам (в фикстуре
   * stream-denied-retry: 0.2536670 → 0.3161740 → 0.3668295), а не наша оценка:
   * считать стоимость по токенам мы по-прежнему не пытаемся. null означает «ни
   * один сегмент ещё не завершился», и это не то же самое, что 0.
   */
  lastResultCostUsd: number | null;
  badLines: number;
  oversizeLines: number;
  unknownTypes: Record<string, number>;
}

/** Внутреннее изменяемое состояние вызова: наружу уходит копия. */
interface OpenToolCall {
  name: string;
  summary: string;
  toolUseId: string | null;
  requestId: string;
  at: number;
  completed: boolean;
  isError: boolean | null;
  repeat: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Увеличивает счётчик с вытеснением самого давнего ключа.
 *
 * Ключ переставляется в конец на каждом обращении: вытесняться должен тот, кто
 * дольше всех не встречался, иначе горячий повторяющийся вызов — ровно тот, ради
 * которого счётчик и заведён, — вымыло бы редкими одноразовыми.
 */
function bump(map: Map<string, number>, key: string, cap: number): number {
  const next = (map.get(key) ?? 0) + 1;
  map.delete(key);
  map.set(key, next);
  if (map.size > cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  return next;
}

function remember(set: Set<string>, key: string, cap: number): boolean {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > cap) {
    const oldest = set.keys().next();
    if (!oldest.done) set.delete(oldest.value);
  }
  return true;
}

export class JobProgress {
  private streaming = false;
  private sessionId: string | null = null;
  private model: string | null = null;
  private finishedAt: number | null = null;
  private lastActivityAt: number | null = null;

  private segments = 0;
  private resultEvents = 0;
  private assistantEvents = 0;
  private assistantTextBlocks = 0;
  private toolCalls = 0;
  private toolResults = 0;
  private toolErrors = 0;
  private thinkingBlocks = 0;
  private thinkingTokenEvents = 0;
  private estimatedThinkingTokens: number | null = null;
  private cacheReadInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private badLines = 0;
  private oversizeLines = 0;
  private lastResultCostUsd: number | null = null;

  private readonly toolsUsed = new Map<string, number>();
  private readonly repeatedCalls = new Map<string, number>();
  private readonly unknownTypes = new Map<string, number>();
  private readonly seenMessageIds = new Set<string>();
  private readonly openCalls = new Map<string, OpenToolCall>();
  private readonly recentEvents: RecentEvent[] = [];

  private lastToolCall: OpenToolCall | null = null;
  private lastAssistantText: string | null = null;
  private rateLimit: RateLimitView | null = null;

  /**
   * Часы инжектируются ради офлайн-проверок простоя и заморозки: события своего
   * timestamp дают не все (у system его нет вообще), а те, что дают, ставят его
   * по часам дочернего процесса. Смешивать два источника времени в idle_seconds
   * нельзя, поэтому активность отмечается только нашими часами.
   */
  constructor(
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Принимает одно событие потока.
   *
   * Вызывается инлайн из обработчика 'data' дочернего процесса, поэтому обязан
   * быть быстрым и не бросать: всё чтение полей — через проверки типов, ни одного
   * предположения о форме события.
   */
  ingest(ev: StreamEvent): void {
    const at = this.now();
    this.streaming = true;
    this.lastActivityAt = at;

    switch (ev.type) {
      case "system":
        this.ingestSystem(ev.data, at);
        break;
      case "assistant":
        this.ingestAssistant(ev.data, at);
        break;
      case "user":
        this.ingestUser(ev.data, at);
        break;
      case "result":
        this.ingestResult(ev.data, at);
        break;
      case "rate_limit_event":
        this.ingestRateLimit(ev.data, at);
        break;
      default: {
        // Вперёд-совместимость по построению: незнакомый тип не теряется и не
        // ломает разбор, а копится по имени и обновляет отметку активности.
        const kind = ev.type === "" ? "(без типа)" : ev.type;
        bump(this.unknownTypes, kind, MAX_UNKNOWN_TYPES);
        this.note(at, kind, "");
      }
    }
  }

  /** Непарсящаяся или слишком длинная строка: это тоже признак жизни процесса. */
  noteBadLine(chars: number, reason: BadLineReason): void {
    const at = this.now();
    this.streaming = true;
    this.lastActivityAt = at;
    this.badLines++;
    if (reason === "too_long") this.oversizeLines++;
    this.note(at, "bad_line", `${reason}, ${chars} симв.`);
  }

  /**
   * Фиксирует конец отсчёта.
   *
   * Без этого отчёт по задаче, закончившейся 40 минут назад, заявил бы 2400
   * секунд простоя. Событий после завершения процесса не бывает, но ingest
   * после freeze не запрещён — заморожено только время, не счётчики.
   */
  freeze(finishedAt: number): void {
    this.finishedAt = finishedAt;
  }

  snapshot(now?: number): ProgressSnapshot {
    const reference = this.finishedAt ?? now ?? this.now();
    const lastActivityAt = this.lastActivityAt;
    return {
      streaming: this.streaming,
      sessionId: this.sessionId,
      model: this.model,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsedMs: Math.max(0, reference - this.startedAt),
      lastActivityAt,
      idleSeconds:
        lastActivityAt === null ? null : Math.max(0, Math.round((reference - lastActivityAt) / 1000)),
      segments: this.segments,
      resultEvents: this.resultEvents,
      assistantEvents: this.assistantEvents,
      assistantTextBlocks: this.assistantTextBlocks,
      toolCalls: this.toolCalls,
      toolResults: this.toolResults,
      toolErrors: this.toolErrors,
      openToolCalls: this.openCalls.size,
      toolsUsed: Object.fromEntries(this.toolsUsed),
      // Копия, а не живой объект: иначе пришедший позже tool_result задним
      // числом менял бы уже снятый снимок.
      lastToolCall: this.lastToolCall === null ? null : { ...this.lastToolCall },
      lastAssistantText: this.lastAssistantText,
      thinkingBlocks: this.thinkingBlocks,
      thinkingTokenEvents: this.thinkingTokenEvents,
      estimatedThinkingTokens: this.estimatedThinkingTokens,
      cacheReadInputTokens: this.cacheReadInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
      rateLimit: this.rateLimit === null ? null : { ...this.rateLimit },
      recentEvents: this.recentEvents.map((e) => ({ ...e })),
      repeatedCalls: Object.fromEntries(this.repeatedCalls),
      lastResultCostUsd: this.lastResultCostUsd,
      badLines: this.badLines,
      oversizeLines: this.oversizeLines,
      unknownTypes: Object.fromEntries(this.unknownTypes),
    };
  }

  private ingestSystem(data: Record<string, unknown>, at: number): void {
    const subtype = asString(data["subtype"]) ?? "";
    switch (subtype) {
      case "init": {
        // Новый сегмент внутри того же процесса. Счётчики НЕ обнуляются: см.
        // шапку файла, на этом держится подсчёт повторов.
        this.segments++;
        this.sessionId = asString(data["session_id"]) ?? this.sessionId;
        this.model = asString(data["model"]) ?? this.model;
        this.note(at, "init", this.model ?? "");
        break;
      }
      case "thinking_tokens": {
        this.thinkingTokenEvents++;
        const estimated = asNumber(data["estimated_tokens"]);
        if (estimated !== null) this.estimatedThinkingTokens = estimated;
        // В кольцо не пишем: пульс размышления летит каждые несколько сотен
        // миллисекунд и вытеснил бы из него всё содержательное.
        break;
      }
      default: {
        const kind = `system/${subtype === "" ? "(без subtype)" : subtype}`;
        bump(this.unknownTypes, kind, MAX_UNKNOWN_TYPES);
        this.note(at, kind, "");
      }
    }
  }

  private ingestAssistant(data: Record<string, unknown>, at: number): void {
    this.assistantEvents++;
    const message = asRecord(data["message"]);
    if (message === null) return;

    // Токены агрегируются по уникальному message.id: события с одним id несут
    // идентичный usage, и наивная сумма по событиям завышает его (в фикстуре
    // stream-denied-retry — 507108 против 305919, в 1.66 раза).
    const messageId = asString(message["id"]);
    if (messageId !== null && remember(this.seenMessageIds, messageId, MAX_MESSAGE_IDS)) {
      const usage = asRecord(message["usage"]);
      if (usage !== null) {
        this.cacheReadInputTokens += asNumber(usage["cache_read_input_tokens"]) ?? 0;
        this.cacheCreationInputTokens += asNumber(usage["cache_creation_input_tokens"]) ?? 0;
      }
    }

    const content = message["content"];
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (block === null) continue;
      switch (asString(block["type"])) {
        case "tool_use":
          this.ingestToolUse(block, at);
          break;
        case "text": {
          const text = asString(block["text"]);
          if (text === null) break;
          this.assistantTextBlocks++;
          this.lastAssistantText = preview(text, MAX_ASSISTANT_TEXT_CHARS);
          this.note(at, "assistant_text", text);
          break;
        }
        case "thinking":
          // Только счётчик: текст рассуждения в снимок не попадает никогда, и
          // полагаться на его наличие всё равно нельзя — в снятых прогонах блок
          // приходит с пустым thinking и одной подписью.
          this.thinkingBlocks++;
          break;
        default:
          break;
      }
    }
  }

  private ingestToolUse(block: Record<string, unknown>, at: number): void {
    const name = asString(block["name"]) ?? "(без имени)";
    const input = block["input"];
    const requestId = computeRequestId(name, input);
    const summary = summarizeToolInput(name, input);

    this.toolCalls++;
    bump(this.toolsUsed, name, MAX_TOOLS_TRACKED);
    const repeat = bump(this.repeatedCalls, requestId, MAX_REPEAT_KEYS);

    const call: OpenToolCall = {
      name,
      summary,
      toolUseId: asString(block["id"]),
      requestId,
      at,
      completed: false,
      isError: null,
      repeat,
    };
    this.lastToolCall = call;
    if (call.toolUseId !== null) {
      this.openCalls.set(call.toolUseId, call);
      if (this.openCalls.size > MAX_OPEN_CALLS) {
        const oldest = this.openCalls.keys().next();
        if (!oldest.done) this.openCalls.delete(oldest.value);
      }
    }
    this.note(at, "tool_use", `${name}: ${summary}`);
  }

  private ingestUser(data: Record<string, unknown>, at: number): void {
    const message = asRecord(data["message"]);
    if (message === null) return;
    const content = message["content"];
    if (!Array.isArray(content)) return;

    for (const raw of content) {
      const block = asRecord(raw);
      if (block === null) continue;
      if (asString(block["type"]) !== "tool_result") continue;

      // Само содержимое tool_result не читается вообще: там лежат тела файлов,
      // вывод команд и текст отказа моста. Берём только идентификатор и флаг.
      this.toolResults++;
      const isError = block["is_error"] === true;
      if (isError) this.toolErrors++;

      const toolUseId = asString(block["tool_use_id"]);
      const call = toolUseId === null ? null : (this.openCalls.get(toolUseId) ?? null);
      if (call !== null && toolUseId !== null) {
        call.completed = true;
        call.isError = isError;
        this.openCalls.delete(toolUseId);
      }
      this.note(at, "tool_result", `${call?.name ?? "?"}: ${isError ? "отказ или ошибка" : "готово"}`);
    }
  }

  private ingestResult(data: Record<string, unknown>, at: number): void {
    // Сегмент завершился — но задача может продолжаться дальше. Обнуляется
    // здесь только одно: ничего.
    this.resultEvents++;
    const cost = asNumber(data["total_cost_usd"]);
    if (cost !== null) this.lastResultCostUsd = cost;
    this.sessionId = asString(data["session_id"]) ?? this.sessionId;
    // num_turns сознательно игнорируется: он посегментный (8, 3, 2 в одной
    // фикстуре), то есть глобальным счётчиком ходов служить не может.
    this.note(at, "result", asString(data["subtype"]) ?? "");
  }

  private ingestRateLimit(data: Record<string, unknown>, at: number): void {
    const info = asRecord(data["rate_limit_info"]);
    if (info === null) return;
    const windows = asRecord(info["unifiedWindows"]);
    const fiveHour = windows === null ? null : asRecord(windows["five_hour"]);
    const status = asString(info["status"]) ?? "";
    this.rateLimit = {
      status,
      utilization: fiveHour === null ? null : asNumber(fiveHour["utilization"]),
      resetsAt:
        (fiveHour === null ? null : asNumber(fiveHour["resetsAt"])) ?? asNumber(info["resetsAt"]),
    };
    this.note(at, "rate_limit", status);
  }

  /**
   * Кольцо последних событий: то, что остаётся вместо отчёта у отменённой или
   * отвалившейся по таймауту задачи.
   *
   * Текст записи собирается только из имён, выжимок ввода и счётчиков — никогда
   * из содержимого tool_result и никогда из блока thinking.
   */
  private note(at: number, kind: string, text: string): void {
    this.recentEvents.push({ at, kind, text: preview(text, RECENT_EVENT_CHARS) });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) this.recentEvents.shift();
  }
}
