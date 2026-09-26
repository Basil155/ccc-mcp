import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { preview, type Logger } from "./logger.js";
import { isReadOnlyCommand } from "./readOnlyCommand.js";

/**
 * Мост PreToolUse-хуков: HTTP-эндпоинт, который решает, пропускать ли
 * чувствительный вызов дочернего Claude Code.
 *
 * Вариант «немедленный deny + retry»: хендлер отвечает мгновенно и никогда не
 * ждёт человека. Незнакомая операция получает отказ с инструкцией дождаться
 * одобрения и повторить ТОТ ЖЕ вызов; одобренная — allow. Благодаря этому
 * таймаут хука в CLI вообще не участвует в логике безопасности.
 *
 * Один инстанс на задачу: свой порт, свой токен, своя карта запросов.
 */

/** Сколько символов tool_input показываем оператору. */
const SUMMARY_CHARS = 300;
/** Предел тела запроса: больше — отказ, тело не буферизуем. */
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * Поля, не влияющие на то, что реально выполнится.
 *
 * description у Bash — свободный текст модели, который она почти наверняка
 * перефразирует при повторе; включать его в ключ значит ломать повтор на ровном
 * месте.
 */
const IGNORED_FIELDS: Record<string, string[]> = { Bash: ["description"] };
/**
 * Примитив ожидания, который мост пропускает без одобрения. Строка матчится
 * целиком — метасимволы невозможны.
 *
 * Безопасна только СИНХРОННАЯ пауза. Она держит модель внутри вызова весь
 * отсчёт, поэтому ход физически не может закрыться раньше, чем у оператора
 * появилось время принять решение, — ровно ради этого исключение и существует.
 * Та же команда с `run_in_background: true` этой работы не делает: Bash
 * возвращается мгновенно, с идентификатором фоновой задачи, модель считает, что
 * ожидание пошло, и закрывает ход, ни разу не повторив отклонённый вызов.
 * Пропуск такого вызова стоил бы потерянного хода и не дал бы ничего взамен,
 * поэтому фоновая пауза идёт через обычное одобрение наравне с любой другой
 * операцией — см. isWaitCommand.
 *
 * Разрешён, но не гарантированно доступен: политика харнесса дочернего CLI
 * может запретить `sleep` в Bash раньше, чем вызов дойдёт до моста. Поэтому
 * подсказка ниже не предписывает именно его.
 */
const WAIT_COMMAND = /^sleep (\d{1,2})$/;
const MAX_WAIT_SECONDS = 60;
/**
 * Поля tool_input у Bash, которые не меняют того, что выполнится: их наличие не
 * мешает автоодобрению. Любое другое поле — повод отправить вызов обычным путём:
 * белый список высказывается про команду, а незнакомое поле может изменить то,
 * как она выполнится.
 */
const AUTO_APPROVE_BASH_FIELDS = new Set([
  "command",
  "description",
  "run_in_background",
  "timeout",
]);

export type RequestDecision = "pending" | "approved" | "denied" | "exhausted";

export interface PermissionRequest {
  /** sha256 от tool_name + канонизированного tool_input, первые 12 hex. */
  requestId: string;
  toolName: string;
  /** Человекочитаемая выжимка tool_input. Сырой ввод наружу не отдаём. */
  summary: string;
  decision: RequestDecision;
  /**
   * Сколько раз хук ответил отказом. Без удержания это число попыток; с
   * удержанием попытка, одобренная во время ожидания, отказом не считается.
   */
  deniedCount: number;
  /** Сколько раз вызов пропущен после одобрения. */
  allowedCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  /** Комментарий оператора при allow/deny. */
  resolvedReason: string | null;
  /**
   * Отказ выдал мост, а не человек: оператор не выходил на связь дольше
   * operatorAbsentMs. Решение окончательное, как у отказа оператора.
   */
  operatorAbsent: boolean;
}

export interface HookBridgeOptions {
  sensitiveTools: string[];
  retryBudget: number;
  maxPendingRequests: number;
  allowWaitCommand: boolean;
  /**
   * Команды Bash, проходящие без одобрения. Сравнение — по всей строке целиком.
   * Пустой список (дефолт) полностью выключает механизм.
   */
  autoApproveCommands: string[];
  /**
   * Пропускать без оператора Bash-команды, которые классификатор признал
   * читающими (isReadOnlyCommand). Включается только для plan_task: там почти
   * вся работа — grep/ls/find, и ручное одобрение каждой команды делало
   * планирование медленным и дорогим. Не задано — выключено.
   */
  autoApproveReadOnly?: boolean;
  /**
   * Сколько миллисекунд оператор не выходил на связь по этой задаче — или null,
   * если он на связи (или механизм выключен). Задаёт владелец задачи: мост сам не
   * знает, когда оператор последний раз её опрашивал.
   *
   * Зачем: 24.09 execute_task 70 минут ждал решения по двум запросам, которые
   * некому было принять (оркестратор потерял связь), и закончился таймаутом без
   * отчёта. Отказ «оператора нет» даёт модели продолжить без операции и отчитаться.
   */
  operatorAbsentMs?: () => number | null;
  /**
   * Сколько держать HTTP-запрос хука открытым в ожидании решения оператора, мс.
   * 0 (дефолт класса) — отвечать отказом сразу и полагаться на повтор моделью.
   *
   * Удержание снимает главную слабость схемы «отказ → повтор»: модель не обязана
   * верить тексту отказа и ждать — вызов ждёт сам, а после одобрения проходит с
   * первой же попытки. Отказ с просьбой повторить остаётся запасным путём на
   * случай, когда оператор не успел.
   *
   * ВАЖНО: истёкший таймаут хука CLI трактует как non-blocking error и ПРОПУСКАЕТ
   * вызов (fail-open). Поэтому мост обязан ответить сам, раньше таймаута: runner
   * выставляет хуку timeout с запасом HOOK_TIMEOUT_MARGIN_SECONDS сверх удержания.
   */
  holdMs?: number;
  logger: Logger;
}

/**
 * Запас таймаута хука сверх удержания, секунды. Покрывает задержки между
 * отправкой ответа мостом и его разбором CLI, чтобы до fail-open дело не дошло.
 */
export const HOOK_TIMEOUT_MARGIN_SECONDS = 60;

interface HookDecision {
  permissionDecision: "allow" | "deny";
  permissionDecisionReason: string;
}

/** Решение отложено: ждём оператора по этому запросу, не дольше holdMs. */
interface HookHold {
  hold: PermissionRequest;
}

export class PermissionRequestError extends Error {}

/**
 * Стабильная сериализация: ключи объектов отсортированы, пробелов нет.
 *
 * Значения НЕ нормализуются (ни trim, ни схлопывание пробелов): иначе другая по
 * смыслу команда могла бы попасть под чужое одобрение.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function stripIgnored(toolName: string, toolInput: unknown): unknown {
  const ignored = IGNORED_FIELDS[toolName];
  if (!ignored || !toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return toolInput;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(toolInput as Record<string, unknown>)) {
    if (!ignored.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Ключ запроса, он же публичный request_id.
 *
 * Это дайджест содержимого вызова, а значит его нельзя угадать, не увидев сам
 * запрос — ровно то же свойство, что у plan_digest в approve_plan.
 */
export function computeRequestId(toolName: string, toolInput: unknown): string {
  const canonical = canonicalJson(stripIgnored(toolName, toolInput));
  return createHash("sha256").update(`${toolName}\n${canonical}`, "utf8").digest("hex").slice(0, 12);
}

/** Короткое описание операции для оператора. Сырой tool_input не раскрываем. */
export function summarizeToolInput(toolName: string, toolInput: unknown): string {
  const input = (
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {}
  ) as Record<string, unknown>;
  const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");

  switch (toolName) {
    case "Bash":
      return preview(str("command"), SUMMARY_CHARS);
    case "Write":
      return `${str("file_path")} (${str("content").length} симв.)`;
    case "Edit":
      return `${str("file_path")}: "${preview(str("old_string"), 80)}" → "${preview(
        str("new_string"),
        80,
      )}"`;
    case "MultiEdit": {
      const edits = Array.isArray(input["edits"]) ? input["edits"].length : 0;
      return `${str("file_path")} (правок: ${edits})`;
    }
    default:
      return preview(canonicalJson(toolInput), SUMMARY_CHARS);
  }
}

function allow(reason: string): HookDecision {
  return { permissionDecision: "allow", permissionDecisionReason: reason };
}

function deny(reason: string): HookDecision {
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}

/**
 * Все тексты отказов начинаются с него: модель должна видеть, откуда пришёл
 * отказ, а не гадать, не подброшена ли ей чужая инструкция.
 */
const SOURCE = "Мост разрешений ccc-mcp:";

/**
 * Текст для случая «ждём оператора» — после истёкшего удержания или без него.
 *
 * Тон сознательно спокойный и описательный. Прежняя версия — капсом,
 * с «ОБЯЗАТЕЛЬНЫМ ПОРЯДКОМ» и «не сообщай о провале» — дочерняя модель на
 * Windows опознала как prompt injection, не стала ждать и сдалась за
 * 10 секунд. Поэтому здесь нет приказов: только факты о том, что происходит,
 * почему повтор того же вызова сработает и почему замена не поможет. Решение,
 * ждать ли или заняться пока другим, остаётся за моделью, и провал она вправе
 * честно отразить в отчёте.
 *
 * Требования те же: не менять аргументы (иначе ключ не совпадёт) и не искать
 * обход (он уйдёт оператору отдельным запросом). Конкретная пауза упоминается
 * только при allowWaitCommand: иначе мост её отклонит и сожжёт попытку. И даже
 * тогда она не единственный вариант: харнесс дочернего CLI может запретить
 * `sleep` раньше моста.
 */
function pendingReason(
  requestId: string,
  attempt: number,
  budget: number,
  allowWaitCommand: boolean,
  heldSeconds = 0,
): string {
  const status =
    heldSeconds > 0
      ? `вызов ждёт решения оператора (запрос ${requestId}), и за ${heldSeconds} с его не было.`
      : `вызов отправлен оператору на одобрение (запрос ${requestId}), решения пока нет.`;
  const pause = allowWaitCommand
    ? " Для паузы подойдёт синхронный `sleep 30` через Bash (без `run_in_background`): он " +
      "проходит без одобрения. Если пауза в этом окружении недоступна, повтор можно сделать и сразу."
    : "";

  return [
    `${SOURCE} ${status} Это не ошибка в команде и не окончательный отказ.`,
    `Одобрение привязано к точным аргументам, поэтому, чтобы продолжить, подождите и повторите ` +
      `этот же вызов без изменений — после одобрения он пройдёт.${pause}`,
    `Изменённый вызов или другая команда с тем же эффектом уйдут оператору новым запросом и ` +
      `ничего не ускорят. Если задачу можно двигать без этой операции, можно заняться другими ` +
      `шагами и вернуться к ней позже.`,
    `Сейчас попытка ${attempt} из ${budget}; после исчерпания операция будет запрещена до конца задачи.`,
  ].join("\n");
}

function exhaustedReason(requestId: string, budget: number): string {
  return (
    `${SOURCE} для запроса ${requestId} исчерпан лимит попыток (${budget}), оператор его не ` +
    `одобрил. Повторять этот вызов больше не нужно: до конца задачи он будет отклоняться. ` +
    `Продолжите без этой операции и укажите в итоговом отчёте, что не сделано и почему.`
  );
}

function operatorDeniedReason(requestId: string, reason: string | null): string {
  const comment = reason && reason.trim() ? ` Комментарий оператора: ${reason.trim()}` : "";
  return (
    `${SOURCE} оператор отклонил запрос ${requestId}.${comment} Повтор будет отклонён так же. ` +
    `Продолжите без этой операции и укажите в итоговом отчёте, что не сделано.`
  );
}

function operatorAbsentReason(requestId: string, minutes: number): string {
  return (
    `${SOURCE} запрос ${requestId} не одобрен: оператор не выходит на связь уже ${minutes} мин. ` +
    `Ждать и повторять эту операцию не нужно — повтор будет отклонён так же. Продолжите то, что ` +
    `можно сделать без неё, и перечислите в итоговом отчёте всё, что осталось несделанным ` +
    `из-за отсутствия одобрения.`
  );
}

function overflowReason(limit: number): string {
  return (
    `${SOURCE} в этой задаче уже ${limit} разных запросов на разрешение — это предел. Каждый ` +
    `новый набор аргументов считается отдельным запросом, и новые варианты этой операции ` +
    `оператору уже не попадут. Продолжите без неё и укажите в итоговом отчёте, что не сделано.`
  );
}

/** Fail-closed: нераспознанное тело — отказ, а не пропуск. */
const REASON_BAD_BODY =
  `${SOURCE} не удалось разобрать запрос хука, поэтому вызов отклонён. Это сбой моста, а не ` +
  "решение оператора: повтор того же вызова, скорее всего, пройдёт.";

const REASON_TOO_LARGE =
  `${SOURCE} аргументы вызова слишком велики для проверки разрешений, поэтому он отклонён. ` +
  "Разбейте операцию на шаги поменьше.";

const REASON_INTERNAL =
  `${SOURCE} внутренняя ошибка проверки разрешений, поэтому вызов отклонён. Повтор того же ` +
  "вызова, скорее всего, пройдёт.";

export class HookBridge {
  private readonly server: Server;
  private readonly requests = new Map<string, PermissionRequest>();
  private port = 0;
  private listening = false;
  /**
   * Ревизия состава запросов, ждущих решения оператора.
   *
   * Растёт, когда появляется новый pending и когда pending исчерпывает бюджет
   * повторов, — то есть ровно тогда, когда оператору нужно что-то решить или
   * узнать, что операция уже не состоится. Не растёт на повторных отказах по
   * известному запросу и на решениях самого оператора: там нового знания для
   * него нет.
   *
   * Нужна не сама по себе, а как источник раннего пробуждения для waitForJob:
   * без неё запрос, возникший через секунду после старта, виден только когда
   * истечёт весь wait_seconds.
   */
  private revision = 0;
  private readonly pendingWatchers = new Set<() => void>();
  /**
   * process_id задачи — только для логов.
   *
   * Мост поднимается раньше, чем JobRegistry выдаёт идентификатор (порт нужен
   * уже для --settings), поэтому значение проставляется вторым шагом.
   */
  private processId = "(не привязан)";
  /**
   * Белый список команд в виде множества: сравнение идёт на каждый вызов хука,
   * а trim записей достаточно сделать один раз здесь — там же, где и сравнение.
   * Пустые после trim строки отбрасываем: иначе пустая команда совпала бы с ними.
   */
  private readonly autoApprove: Set<string>;
  /**
   * Удерживаемые HTTP-запросы по request_id. Колбэк получает решение оператора и
   * сам отвечает CLI; таймер удержания и обрыв соединения снимают его отсюда.
   */
  private readonly holds = new Map<string, Set<(decision: "allow" | "deny") => void>>();

  private constructor(
    private readonly opts: HookBridgeOptions,
    private readonly token: string,
  ) {
    this.autoApprove = new Set(opts.autoApproveCommands.map((c) => c.trim()).filter(Boolean));
    this.server = createServer((req, res) => {
      this.handle(req, res);
    });
  }

  static async start(opts: HookBridgeOptions): Promise<HookBridge> {
    const bridge = new HookBridge(opts, randomUUID());
    await bridge.listen();
    return bridge;
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once("error", onError);
      // Явно 127.0.0.1 — не 0.0.0.0 и не ::. Порт 0: свободный выдаёт ОС,
      // поэтому мост обязан слушать ДО спавна claude, иначе URL неизвестен.
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        const address = this.server.address();
        this.port = typeof address === "object" && address !== null ? address.port : 0;
        this.listening = true;
        resolve();
      });
    });
    // Подвисший мост не должен удерживать процесс от выхода: живым его держит
    // stdio-транспорт MCP.
    this.server.unref();
  }

  /**
   * URL для --settings. Токен в пути — защита не от дочернего claude (он видит
   * свой argv), а от посторонних локальных процессов, которые иначе могли бы
   * вслепую бомбить порт и жечь retryBudget чужой задачи.
   */
  get url(): string {
    return `http://127.0.0.1:${this.port}/hook/${this.token}`;
  }

  /** Привязывает мост к задаче — влияет только на логи. */
  attachProcessId(processId: string): void {
    this.processId = processId;
  }

  /** Копии записей, по времени первого появления. */
  list(): PermissionRequest[] {
    return [...this.requests.values()]
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
      .map((r) => ({ ...r }));
  }

  /** Сколько запросов ждут решения оператора прямо сейчас. */
  pendingCount(): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.decision === "pending") n++;
    return n;
  }

  /** Текущая ревизия состава ожидающих запросов. */
  get pendingRevision(): number {
    return this.revision;
  }

  /**
   * Подписка на изменение состава ожидающих запросов.
   *
   * @returns функция отписки. Вызывать обязательно: иначе колбэк останется
   *          в наборе и будет вызван уже после того, как ожидающий ушёл.
   */
  onPendingChange(callback: () => void): () => void {
    this.pendingWatchers.add(callback);
    return () => {
      this.pendingWatchers.delete(callback);
    };
  }

  /**
   * Двигает ревизию и будит подписчиков.
   *
   * Копия набора перед обходом и try/catch на каждого: вызов идёт из обработчика
   * хука, который обязан ответить дочернему CLI при любом исходе. Упавший
   * подписчик не должен превратиться в отсутствие ответа.
   */
  private notifyPending(): void {
    this.revision++;
    for (const watcher of [...this.pendingWatchers]) {
      try {
        watcher();
      } catch (err) {
        this.opts.logger.stderr(`hookBridge: подписчик pending упал: ${String(err)}`);
      }
    }
  }

  /**
   * Решение оператора.
   *
   * allow «липкий» в пределах задачи, а не одноразовый: хук вполне может
   * сработать по одному ключу больше раза (ретрай CLI, повтор после сжатия
   * транскрипта), и одноразовое разрешение «съела» бы попытка, не доведшая дело
   * до конца. Отзыв — повторный вызов с decision "deny".
   */
  resolve(requestId: string, decision: "allow" | "deny", reason?: string): PermissionRequest {
    const record = this.requests.get(requestId);
    if (!record) {
      const known = this.list().map((r) => r.requestId);
      throw new PermissionRequestError(
        `запрос ${requestId} не найден. Известные request_id этой задачи: ` +
          `${known.length ? known.join(", ") : "(пока ни одного)"}. ` +
          `Возьмите значение из permission_requests в ответе get_task_status.`,
      );
    }
    record.decision = decision === "allow" ? "approved" : "denied";
    record.resolvedAt = Date.now();
    record.resolvedReason = reason?.trim() ? reason.trim() : null;
    // Удерживаемые вызовы отвечаем сразу — ради этого их и держали.
    const waiters = this.holds.get(requestId);
    if (waiters) {
      this.holds.delete(requestId);
      for (const waiter of waiters) waiter(decision);
    }
    return { ...record };
  }

  /** Закрывает порт, но сохраняет карту запросов: отчёт по завершённой задаче её показывает. */
  stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    // Завершённая задача не должна держать ожидающих: новых запросов уже не
    // будет, и подписка только удерживала бы ссылки.
    this.pendingWatchers.clear();
    // Удерживаемые соединения закроет closeAllConnections; ответить на них уже
    // некому — задача кончилась, — поэтому колбэки просто забываем.
    this.holds.clear();
    this.server.close();
    this.server.closeAllConnections();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST" || req.url !== `/hook/${this.token}`) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Отвечаем сразу и перестаём копить: память ограничена, а соединение
        // закрывается штатно. Рвать сокет нельзя — уже записанный ответ мог бы
        // не долететь, и CLI счёл бы это падением хука.
        aborted = true;
        chunks.length = 0;
        this.respond(res, deny(REASON_TOO_LARGE));
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", () => {
      if (aborted) return;
      aborted = true;
      if (!res.writableEnded) this.respond(res, deny(REASON_BAD_BODY));
    });

    req.on("end", () => {
      if (aborted) return;
      let decision: HookDecision | HookHold;
      try {
        decision = this.decide(Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        // Fail-closed: внутренний сбой — отказ, а не 500 и тем более не allow.
        this.opts.logger.stderr(`hookBridge: сбой обработчика: ${String(err)}`);
        decision = deny(REASON_INTERNAL);
      }
      if ("hold" in decision) {
        this.holdUntilDecided(decision.hold, res);
      } else {
        this.respond(res, decision);
      }
    });
  }

  /**
   * Держит ответ, пока оператор не решит или не истечёт holdMs.
   *
   * Ровно один ответ на соединение: флаг settled защищает от гонки таймера,
   * решения оператора и обрыва. Обрыв (CLI отменил вызов, задачу сняли) — не
   * решение: колбэк снимается, а запрос остаётся pending для следующей попытки.
   */
  private holdUntilDecided(record: PermissionRequest, res: ServerResponse): void {
    const holdMs = this.opts.holdMs ?? 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const release = (): void => {
      settled = true;
      if (timer) clearTimeout(timer);
      const set = this.holds.get(record.requestId);
      if (set) {
        set.delete(onDecision);
        if (set.size === 0) this.holds.delete(record.requestId);
      }
    };

    const onDecision = (decision: "allow" | "deny"): void => {
      if (settled) return;
      release();
      if (decision === "allow") {
        record.allowedCount++;
        this.log(record, "allow");
        this.respond(res, allow(`Операция одобрена оператором (запрос ${record.requestId}).`));
      } else {
        record.deniedCount++;
        this.log(record, "deny");
        this.respond(res, deny(operatorDeniedReason(record.requestId, record.resolvedReason)));
      }
    };

    let set = this.holds.get(record.requestId);
    if (!set) {
      set = new Set();
      this.holds.set(record.requestId, set);
    }
    set.add(onDecision);

    timer = setTimeout(() => {
      if (settled) return;
      release();
      record.deniedCount++;
      this.log(record, "deny");
      this.respond(
        res,
        deny(
          pendingReason(
            record.requestId,
            record.deniedCount,
            this.opts.retryBudget,
            this.opts.allowWaitCommand,
            // ceil: удержание короче секунды не должно превращаться в «за 0 с».
            Math.ceil(holdMs / 1000),
          ),
        ),
      );
    }, holdMs);
    timer.unref();

    res.on("close", () => {
      if (!settled) release();
    });
  }

  private decide(bodyText: string): HookDecision | HookHold {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("тело не является объектом");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return deny(REASON_BAD_BODY);
    }

    const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : "";
    const toolInput = payload["tool_input"];

    // Вне политики — пропускаем. Дублирует matcher из --settings на случай, если
    // он сработал шире ожидаемого.
    if (!toolName || !this.opts.sensitiveTools.includes(toolName)) {
      return allow("Инструмент не входит в список контролируемых.");
    }

    // Санкционированная пауза: если этот примитив в окружении доступен, он даёт
    // модели дождаться решения, не сжигая бюджет мгновенными ретраями. Записи не
    // заводим — ждать оператора разрешено и без него, любым другим способом.
    if (this.isWaitCommand(toolName, toolInput)) {
      return allow("Пауза разрешена без одобрения.");
    }

    // Точная команда из белого списка оператора. Решение мгновенное и записи не
    // заводит: эпизода «отказ → ожидание → одобрение» тут не возникает, ждать
    // нечего. В лог идёт отдельным decision — аудит обязан отличать
    // автоодобрение от решения человека.
    if (this.isAutoApprovedCommand(toolName, toolInput)) {
      this.logAutoAllowed(toolName, toolInput, "exact");
      return allow("Команда входит в список автоодобрения оператора.");
    }

    // Читающая команда в планировании. Классификатор консервативен: всё, в чём он
    // не уверен, идёт дальше обычным путём, к оператору.
    if (this.isReadOnlyAutoApproved(toolName, toolInput)) {
      this.logAutoAllowed(toolName, toolInput, "read_only");
      return allow("Команда только читает — одобрена мостом без оператора.");
    }

    const requestId = computeRequestId(toolName, toolInput);
    const now = Date.now();
    const existing = this.requests.get(requestId);

    if (existing) {
      existing.lastSeenAt = now;

      if (existing.decision === "approved") {
        existing.allowedCount++;
        this.log(existing, "allow");
        return allow(`Операция одобрена оператором (запрос ${requestId}).`);
      }

      // Оператора нет: ждущий запрос закрываем окончательным отказом, а не
      // гоняем модель по кругу «подожди и повтори» до таймаута задачи.
      if (existing.decision === "pending") {
        const absent = this.absentMinutes();
        if (absent !== null) return this.denyAbsent(existing, absent, now);
      }

      // Удерживаемая попытка ещё не отказ: засчитается, только если ей в итоге
      // откажут (таймер или оператор). Иначе одобренный с первого раза вызов
      // показывал бы denied_count: 1. Порог бюджета тот же: эта попытка —
      // deniedCount + 1-я.
      if (existing.decision === "pending" && this.holding) {
        if (existing.deniedCount + 1 > this.opts.retryBudget) {
          existing.deniedCount++;
          existing.decision = "exhausted";
          existing.resolvedAt = now;
          this.log(existing, "deny");
          this.notifyPending();
          return deny(exhaustedReason(requestId, this.opts.retryBudget));
        }
        return { hold: existing };
      }

      existing.deniedCount++;

      if (existing.decision === "denied") {
        this.log(existing, "deny");
        return deny(operatorDeniedReason(requestId, existing.resolvedReason));
      }
      if (existing.decision === "exhausted") {
        this.log(existing, "deny");
        return deny(exhaustedReason(requestId, this.opts.retryBudget));
      }

      // pending: попытка сверх бюджета запрещает операцию до конца задачи.
      // Fail-closed — allow-fallback означал бы, что разрешение можно продавить.
      if (existing.deniedCount > this.opts.retryBudget) {
        existing.decision = "exhausted";
        existing.resolvedAt = now;
        this.log(existing, "deny");
        // Запрос перестал быть решаемым: операция уже не состоится, и оператору
        // стоит узнать об этом сразу, а не когда истечёт его wait_seconds.
        this.notifyPending();
        return deny(exhaustedReason(requestId, this.opts.retryBudget));
      }
      this.log(existing, "deny");
      return deny(
        pendingReason(
          requestId,
          existing.deniedCount,
          this.opts.retryBudget,
          this.opts.allowWaitCommand,
        ),
      );
    }

    // Защита памяти от модели, бесконечно варьирующей аргументы: запись не
    // создаём вовсе.
    if (this.requests.size >= this.opts.maxPendingRequests) {
      this.opts.logger.write({
        event: "hook",
        process_id: this.processId,
        request_id: requestId,
        tool_name: toolName,
        outcome: "deny",
        decision: "overflow",
      });
      return deny(overflowReason(this.opts.maxPendingRequests));
    }

    const created: PermissionRequest = {
      requestId,
      toolName,
      summary: summarizeToolInput(toolName, toolInput),
      decision: "pending",
      // При удержании отказа пока не было — см. ветку pending выше.
      deniedCount: this.holding ? 0 : 1,
      allowedCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      resolvedReason: null,
      operatorAbsent: false,
    };
    this.requests.set(requestId, created);
    // Оператора нет — не держим вызов и не просим повторить: сразу окончательный
    // отказ. Запись всё равно заводим, чтобы оператор, вернувшись, увидел, что
    // именно не было сделано.
    const absent = this.absentMinutes();
    if (absent !== null) {
      created.deniedCount = 0;
      return this.denyAbsent(created, absent, now);
    }
    // Главное место пробуждения: именно здесь у оператора появляется работа.
    // При удержании лог пишется по итогу — одобрением или отказом по таймеру.
    if (this.holding) {
      this.notifyPending();
      return { hold: created };
    }
    this.log(created, "deny");
    this.notifyPending();
    return deny(pendingReason(requestId, 1, this.opts.retryBudget, this.opts.allowWaitCommand));
  }

  /** Минуты молчания оператора, если он считается отсутствующим, иначе null. */
  private absentMinutes(): number | null {
    const ms = this.opts.operatorAbsentMs?.() ?? null;
    return ms === null ? null : Math.max(1, Math.round(ms / 60_000));
  }

  /** Окончательный отказ за отсутствием оператора. */
  private denyAbsent(record: PermissionRequest, minutes: number, now: number): HookDecision {
    record.deniedCount++;
    record.decision = "denied";
    record.operatorAbsent = true;
    record.resolvedAt = now;
    record.resolvedReason = `оператор не выходил на связь ${minutes} мин`;
    this.log(record, "deny");
    this.notifyPending();
    return deny(operatorAbsentReason(record.requestId, minutes));
  }

  /** Держать ли ответ в ожидании оператора, а не отказывать сразу. */
  private get holding(): boolean {
    return (this.opts.holdMs ?? 0) > 0;
  }

  private isWaitCommand(toolName: string, toolInput: unknown): boolean {
    if (!this.opts.allowWaitCommand || toolName !== "Bash") return false;
    if (!toolInput || typeof toolInput !== "object") return false;
    const input = toolInput as Record<string, unknown>;
    // Фоновая пауза не заставляет модель ждать — см. комментарий у WAIT_COMMAND.
    // Проверка на truthy, а не === true: непонятное значение трактуем как фон.
    if (input["run_in_background"]) return false;
    const command = input["command"];
    if (typeof command !== "string") return false;
    const match = WAIT_COMMAND.exec(command.trim());
    if (!match) return false;
    return Number(match[1]) <= MAX_WAIT_SECONDS;
  }

  /**
   * Команда целиком совпала со строкой из autoApproveCommands.
   *
   * Соседство с isWaitCommand не случайно — обе проверки решают вызов мгновенно и
   * без записи в реестре, — но общей абстракции они не образуют: у паузы
   * обоснование в том, что она заставляет модель ждать, а здесь — в том, что
   * команда безобидна и бесплатна. Поэтому и фон трактуется по-разному: фоновая
   * пауза бессмысленна, а фоновая сборка — обычный способ её запустить.
   *
   * Нормализация ограничена trim: хвостовые пробелы не меняют того, что выполнит
   * shell, а вот схлопывание внутренних меняло бы — `echo "a  b"` прошло бы по
   * одобрению `echo "a b"`.
   */
  private isAutoApprovedCommand(toolName: string, toolInput: unknown): boolean {
    if (this.autoApprove.size === 0 || toolName !== "Bash") return false;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return false;
    const input = toolInput as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!AUTO_APPROVE_BASH_FIELDS.has(key)) return false;
    }
    const command = input["command"];
    if (typeof command !== "string") return false;
    const trimmed = command.trim();
    return trimmed.length > 0 && this.autoApprove.has(trimmed);
  }

  /**
   * Лог автоодобренного вызова: записи PermissionRequest у него нет, поэтому
   * пишем напрямую — как это делает ветка overflow.
   *
   * request_id считаем, хотя запись не создаётся: по нему автоодобренный вызов
   * сопоставляется с тем же вызовом, если команду уберут из конфига и он пойдёт
   * обычным путём. denied_count/allowed_count намеренно отсутствуют — считать
   * тут нечего.
   */
  private logAutoAllowed(toolName: string, toolInput: unknown, rule: "exact" | "read_only"): void {
    this.opts.logger.write({
      event: "hook",
      process_id: this.processId,
      request_id: computeRequestId(toolName, toolInput),
      tool_name: toolName,
      summary: summarizeToolInput(toolName, toolInput),
      outcome: "allow",
      decision: "auto_allowed",
      rule,
    });
  }

  /**
   * Bash-команда, признанная читающей, при включённом autoApproveReadOnly.
   * Те же ограничения на поля tool_input, что у точного списка.
   */
  private isReadOnlyAutoApproved(toolName: string, toolInput: unknown): boolean {
    if (!this.opts.autoApproveReadOnly || toolName !== "Bash") return false;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return false;
    const input = toolInput as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!AUTO_APPROVE_BASH_FIELDS.has(key)) return false;
    }
    const command = input["command"];
    return typeof command === "string" && isReadOnlyCommand(command);
  }

  private log(record: PermissionRequest, outcome: "allow" | "deny"): void {
    this.opts.logger.write({
      event: "hook",
      process_id: this.processId,
      request_id: record.requestId,
      tool_name: record.toolName,
      summary: record.summary,
      decision: record.decision,
      outcome,
      denied_count: record.deniedCount,
      allowed_count: record.allowedCount,
      ...(record.operatorAbsent ? { operator_absent: true } : {}),
    });
  }

  private respond(res: ServerResponse, decision: HookDecision, done?: () => void): void {
    const body = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.permissionDecision,
        permissionDecisionReason: decision.permissionDecisionReason,
      },
    });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(body, done);
  }
}
