import type { PermissionRequest } from "./hookBridge.js";
import type { ProgressSnapshot } from "./progress.js";

/**
 * Детектор паттернов: что происходит с идущей задачей прямо сейчас.
 *
 * Снимок JobProgress — это два десятка счётчиков, из которых вызывающему агенту
 * нужен один вывод: подождать, одобрить операцию или отменить задачу. Этот
 * модуль и делает такой вывод — по фиксированному набору условий и с жёстким
 * порядком приоритета, чтобы одна и та же ситуация всегда описывалась одной и
 * той же фразой.
 *
 * Функция чистая по построению: никаких часов (now приходит параметром), ни
 * одного обращения к логгеру, ни одной мутации входных данных. Импортируются
 * только типы, ./jobs.js не импортируется вовсе — цикл невозможен.
 *
 * Наружу не выносится ничего сверх того, что уже показано оператору: имена
 * инструментов, выжимки summarizeToolInput и счётчики. Тела tool_result и
 * блоки thinking в снимке отсутствуют, и полагаться на них здесь нечем.
 *
 * Завершённая задача не диагностируется вовсе (см. detectPatterns): у неё есть
 * настоящий отчёт, а «простой 900 секунд» на замороженном снимке был бы просто
 * временем, прошедшим с последнего события до конца прогона.
 */

/** За минуту процесс не дал ни одной строки — сломан запуск, а не идёт работа. */
const NO_PROGRESS_MS = 60_000;
/**
 * Порог простоя.
 *
 * Пульс system/thinking_tokens идёт раз в сотни миллисекунд, пока модель
 * размышляет, поэтому три минуты полной тишины — это действительно тишина, а не
 * долгая мысль.
 */
const IDLE_STALL_SECONDS = 180;
/** Столько отказов по одному запросу — модель уже в цикле повторов. */
const RETRY_LOOP_DENIALS = 3;
/** Столько одновременных pending — модель перебирает аргументы, а не просит операцию. */
const FLOODING_PENDING = 5;
/** Третий побайтово тот же вызов — это круг, а не ретрай. */
const REPEATED_CALL_LIMIT = 3;
/** Пять минут размышления без единого видимого действия. */
const THINKING_ONLY_MS = 300_000;
/** Ниже этого «allowed» — обычная работа: в фикстурах пятичасовое окно 0.11–0.17. */
const RATE_LIMIT_UTILIZATION = 0.95;

/**
 * Важность паттерна: больше — важнее.
 *
 * Порядок не произвольный, а по тому, от кого требуется действие. Сначала то,
 * где ждут человека (90–60): без него задача стоит или уже искалечена. Затем то,
 * что сломано или идёт не туда (50–45): ждать бесполезно, но и одобрять нечего.
 * И только потом объяснения происходящего (40–10), где правильный ответ обычно
 * «подождите».
 *
 * Два намеренных решения внутри порядка:
 *
 * - rate_limited выше stalled, потому что лимит ОБЪЯСНЯЕТ тишину. Иначе отчёт
 *   советовал бы отменить задачу, которая просто ждёт своего окна.
 * - tool_running в самом низу: это хорошая новость («Bash с тестами честно
 *   работает»), и существует паттерн ровно затем, чтобы вместо него не выдался
 *   ложный stalled.
 */
const SEVERITY = {
  permissionExhausted: 90,
  permissionRetryLoop: 80,
  permissionFlooding: 70,
  pendingPermission: 60,
  noProgress: 50,
  repeatedToolCall: 45,
  rateLimited: 40,
  stalled: 35,
  thinkingOnly: 20,
  toolRunning: 10,
} as const;

export type PatternCode =
  | "permission_exhausted"
  | "permission_retry_loop"
  | "permission_flooding"
  | "pending_permission"
  | "no_progress"
  | "repeated_tool_call"
  | "rate_limited"
  | "stalled"
  | "thinking_only"
  | "tool_running";

/** Плоские значения: годятся и в отчёт, и в лог, и в подстановку во фразу. */
export type PatternDetails = Record<string, string | number | boolean | null>;

export interface Pattern {
  code: PatternCode;
  /** Больше — важнее. Значения из таблицы SEVERITY. */
  severity: number;
  /** Готовая фраза для next_step: уже с process_id, именами и выжимками. */
  message: string;
  details: PatternDetails;
}

export interface DiagnoseInput {
  tool: "plan_task" | "execute_task";
  processId: string;
  /** Часы вызывающего: те же, по которым JobProgress отмечал активность. */
  now: number;
  snapshot: ProgressSnapshot;
  /** То же, что отдаётся в permission_requests: HookBridge.list(). */
  permissions: PermissionRequest[];
  /**
   * config.streamEvents.
   *
   * При false раннер работает буферным путём и снимок не наполняется вообще —
   * пустое состояние тогда норма, а не зависание, и no_progress выдавать нельзя.
   */
  streamEnabled: boolean;
}

export interface Diagnosis {
  pattern: PatternCode | null;
  /** 0, когда pattern === null. */
  severity: number;
  message: string | null;
  details: PatternDetails;
  /** Все сработавшие паттерны по убыванию важности, включая главный. */
  patterns: Pattern[];
}

/** Запросы, ждущие решения оператора, от самого раннего к позднему. */
function byFirstSeen(a: PermissionRequest, b: PermissionRequest): number {
  return a.firstSeenAt - b.firstSeenAt;
}

function seconds(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 1000));
}

/**
 * Все сработавшие паттерны, от самого важного к наименее.
 *
 * Стоимость O(1) с точностью до обхода двух ограниченных карт (repeatedCalls
 * ≤200 ключей, список запросов ≤maxPendingRequests), а зовётся функция раз на
 * построение отчёта, то есть на вызов инструмента, а не на событие потока.
 */
export function detectPatterns(input: DiagnoseInput): Pattern[] {
  const { snapshot, permissions, now, processId, tool, streamEnabled } = input;
  const found: Pattern[] = [];

  // Завершённая задача: у неё есть настоящий отчёт, и любые выводы про простой и
  // незакрытые вызовы относились бы к моменту, который уже прошёл.
  if (snapshot.finishedAt !== null) return found;

  const pending = permissions.filter((p) => p.decision === "pending").sort(byFirstSeen);
  const exhausted = permissions.filter((p) => p.decision === "exhausted").sort(byFirstSeen);
  const pendingCount = pending.length;

  // 1. permission_exhausted — бюджет повторов израсходован.
  const dead = exhausted[0];
  if (dead !== undefined) {
    found.push({
      code: "permission_exhausted",
      severity: SEVERITY.permissionExhausted,
      message:
        `Дочерний Claude Code исчерпал бюджет повторов по запросу ${dead.requestId} ` +
        `(${dead.toolName}: «${dead.summary}»). Модели велено прекратить попытки этой операции, ` +
        `поэтому одобрение задним числом, скорее всего, уже ничего не изменит: задача доедет без ` +
        `неё и сообщит в отчёте, что осталось не сделано.` +
        (exhausted.length > 1 ? ` Всего таких запросов: ${exhausted.length}.` : "") +
        ` Решите с пользователем: оборвать задачу через cancel_task с process_id "${processId}" и ` +
        `перепланировать или дождаться неполного результата.`,
      details: {
        request_id: dead.requestId,
        tool_name: dead.toolName,
        summary: dead.summary,
        denied_count: dead.deniedCount,
        exhausted_count: exhausted.length,
        age_seconds: seconds(dead.firstSeenAt, now),
      },
    });
  }

  // 2. permission_retry_loop — по одному запросу уже несколько отказов подряд.
  const loop = pending
    .filter((p) => p.deniedCount >= RETRY_LOOP_DENIALS)
    .sort((a, b) => b.deniedCount - a.deniedCount || a.firstSeenAt - b.firstSeenAt)[0];
  if (loop !== undefined) {
    found.push({
      code: "permission_retry_loop",
      severity: SEVERITY.permissionRetryLoop,
      message:
        `Дочерний Claude Code ${loop.deniedCount}-й раз просит одобрить один и тот же вызов ` +
        `${loop.requestId} (${loop.toolName}: «${loop.summary}») и жжёт на этом ходы. Бюджет ` +
        `повторов конечен: когда он кончится, операция станет невозможной до конца задачи. ` +
        `Решите сейчас — approve_permission_request с process_id "${processId}" и request_id ` +
        `"${loop.requestId}".`,
      details: {
        request_id: loop.requestId,
        tool_name: loop.toolName,
        summary: loop.summary,
        denied_count: loop.deniedCount,
        pending_count: pendingCount,
        age_seconds: seconds(loop.firstSeenAt, now),
      },
    });
  }

  // 3. permission_flooding — запросов больше, чем оператор успеет рассмотреть.
  if (pendingCount >= FLOODING_PENDING) {
    const oldest = pending[0];
    found.push({
      code: "permission_flooding",
      severity: SEVERITY.permissionFlooding,
      message:
        `Одновременно ждут решения ${pendingCount} разных запросов на разрешение — дочерний ` +
        `Claude Code перебирает варианты операции, а не просит одну. Одобрять их по одному обычно ` +
        `неправильно: покажите список пользователю и рассмотрите cancel_task с process_id ` +
        `"${processId}" с последующим уточнением задачи.`,
      details: {
        pending_count: pendingCount,
        request_id: oldest?.requestId ?? null,
        tool_name: oldest?.toolName ?? null,
        summary: oldest?.summary ?? null,
        age_seconds: oldest === undefined ? null : seconds(oldest.firstSeenAt, now),
      },
    });
  }

  // 4. pending_permission — обычный случай, только если не подошёл более
  //    специфичный паттерн выше: иначе одна ситуация описывалась бы дважды.
  const specificPermission = found.some(
    (p) => p.code === "permission_retry_loop" || p.code === "permission_flooding",
  );
  const oldestPending = pending[0];
  if (oldestPending !== undefined && !specificPermission) {
    found.push({
      code: "pending_permission",
      severity: SEVERITY.pendingPermission,
      message:
        `Задача выполняется, но ${pendingCount} операц. ждут вашего разрешения: ` +
        `${oldestPending.toolName} («${oldestPending.summary}»), запрос ${oldestPending.requestId}, ` +
        `${seconds(oldestPending.firstSeenAt, now)} с назад. Покажите их пользователю и для каждой ` +
        `вызовите approve_permission_request с process_id "${processId}" и request_id из ` +
        `permission_requests. Без решения дочерний Claude Code будет отклонён и продолжит без них.`,
      details: {
        request_id: oldestPending.requestId,
        tool_name: oldestPending.toolName,
        summary: oldestPending.summary,
        denied_count: oldestPending.deniedCount,
        pending_count: pendingCount,
        age_seconds: seconds(oldestPending.firstSeenAt, now),
      },
    });
  }

  // 5. no_progress — процесс запущен, но не дал ни одной строки.
  //
  //    Проверка идёт по lastActivityAt, а не по streaming: JobProgress выставляет
  //    оба поля одной и той же парой строк, поэтому условие «streaming, но
  //    активности не было» невыполнимо в принципе. В режиме stream-json строка
  //    system/init приходит примерно через секунду после спавна, так что минута
  //    полного молчания означает, что CLI не дошёл даже до неё.
  if (streamEnabled && snapshot.lastActivityAt === null && snapshot.elapsedMs >= NO_PROGRESS_MS) {
    found.push({
      code: "no_progress",
      severity: SEVERITY.noProgress,
      message:
        `За ${Math.round(snapshot.elapsedMs / 1000)} с дочерний Claude Code не выдал ни одной ` +
        `строки потока — он не дошёл даже до первого хода. Обычные причины: не пройдена ` +
        `авторизация claude, недоступна модель, не поддержан stream-json. Ждать смысла нет: ` +
        `отмените задачу через cancel_task с process_id "${processId}" и посмотрите stderr в логе.`,
      details: {
        elapsed_ms: snapshot.elapsedMs,
        bad_lines: snapshot.badLines,
        stream_enabled: streamEnabled,
      },
    });
  }

  // 6. repeated_tool_call — модель ходит по кругу. Работает по данным потока и
  //    не зависит от хуков, а hooksEnabled по умолчанию выключен.
  let topRepeatId: string | null = null;
  let topRepeatCount = 0;
  for (const [requestId, count] of Object.entries(snapshot.repeatedCalls)) {
    if (count > topRepeatCount) {
      topRepeatCount = count;
      topRepeatId = requestId;
    }
  }
  if (topRepeatId !== null && topRepeatCount >= REPEATED_CALL_LIMIT) {
    // Имя и выжимку берём только у совпавшего последнего вызова: у остальных
    // отпечатков в карте нет ничего, кроме идентификатора, и выдумывать нельзя.
    const same = snapshot.lastToolCall?.requestId === topRepeatId ? snapshot.lastToolCall : null;
    const what = same === null ? `вызов ${topRepeatId}` : `${same.name} («${same.summary}»)`;
    found.push({
      code: "repeated_tool_call",
      severity: SEVERITY.repeatedToolCall,
      message:
        `Дочерний Claude Code ${topRepeatCount} раз повторил один и тот же ${what} — побайтово с ` +
        `теми же аргументами. Похоже, задача пошла по кругу и жжёт токены. Посмотрите ` +
        `progress.recent_events и решите с пользователем, не пора ли остановить её через ` +
        `cancel_task с process_id "${processId}".`,
      details: {
        request_id: topRepeatId,
        count: topRepeatCount,
        tool_name: same?.name ?? null,
        summary: same?.summary ?? null,
        tool_calls: snapshot.toolCalls,
      },
    });
  }

  // 7. rate_limited — объяснение медленной работы, от которого отмена не спасёт.
  const rate = snapshot.rateLimit;
  if (
    rate !== null &&
    (rate.status !== "allowed" ||
      (rate.utilization !== null && rate.utilization >= RATE_LIMIT_UTILIZATION))
  ) {
    const share = rate.utilization === null ? "неизвестна" : `${Math.round(rate.utilization * 100)}%`;
    found.push({
      code: "rate_limited",
      severity: SEVERITY.rateLimited,
      message:
        `Задача упёрлась в лимит использования: статус «${rate.status}», выработка пятичасового ` +
        `окна ${share}. Это объясняет медленную работу или тишину — отмена и перезапуск не ` +
        `помогут, задача пойдёт дальше сама. Опрашивайте get_task_status с большим wait_seconds.`,
      details: {
        status: rate.status,
        utilization: rate.utilization,
        resets_at: rate.resetsAt,
        idle_seconds: snapshot.idleSeconds,
      },
    });
  }

  // 8 и 10. stalled против tool_running: один и тот же простой, разный вывод.
  //
  //    Делим по openToolCalls, а не по lastToolCall.completed: последний вызов
  //    может быть уже закрыт, пока более ранний параллельный всё ещё висит, и по
  //    одному только последнему это выглядело бы как зависание.
  const idle = snapshot.idleSeconds;
  if (idle !== null && idle >= IDLE_STALL_SECONDS) {
    if (snapshot.openToolCalls === 0) {
      found.push({
        code: "stalled",
        severity: SEVERITY.stalled,
        message:
          `Ни одного события потока уже ${idle} с, и при этом ни один вызов инструмента не ` +
          `выполняется. Пульс размышления идёт раз в доли секунды, поэтому такая тишина похожа на ` +
          `зависание. Сделано к этому моменту: вызовов инструментов ${snapshot.toolCalls}, ходов ` +
          `ассистента ${snapshot.assistantEvents}. Проверьте progress.recent_events и решите с ` +
          `пользователем, не остановить ли задачу через cancel_task с process_id "${processId}".`,
        details: {
          idle_seconds: idle,
          tool_calls: snapshot.toolCalls,
          assistant_events: snapshot.assistantEvents,
          open_tool_calls: 0,
        },
      });
    } else {
      // Незакрытый вызов — именно тот случай, ради которого паттерн заведён:
      // «Bash с тестами работает четвёртую минуту» это не зависание.
      const open =
        snapshot.lastToolCall !== null && !snapshot.lastToolCall.completed
          ? snapshot.lastToolCall
          : null;
      const what = open === null ? "инструмент" : `${open.name} («${open.summary}»)`;
      const running = open === null ? idle : seconds(open.at, now);
      found.push({
        code: "tool_running",
        severity: SEVERITY.toolRunning,
        message:
          `Событий нет ${idle} с, но это не зависание: ${what} физически выполняется уже ` +
          `${running} с (незакрытых вызовов: ${snapshot.openToolCalls}). Ничего делать не нужно — ` +
          `опросите get_task_status с process_id "${processId}" и большим wait_seconds.`,
        details: {
          idle_seconds: idle,
          open_tool_calls: snapshot.openToolCalls,
          tool_name: open?.name ?? null,
          summary: open?.summary ?? null,
          running_seconds: open === null ? null : running,
        },
      });
    }
  }

  // 9. thinking_only — думает давно, видимых действий пока ноль.
  //
  //    Счётчики снимка накопительные от старта задачи, поэтому «не растут» для
  //    одного снимка — это просто «равны нулю». Только для execute_task: в
  //    plan_task размышление без действий и есть работа.
  if (
    tool === "execute_task" &&
    snapshot.elapsedMs >= THINKING_ONLY_MS &&
    snapshot.toolCalls === 0 &&
    snapshot.assistantTextBlocks === 0 &&
    snapshot.thinkingTokenEvents >= 1
  ) {
    found.push({
      code: "thinking_only",
      severity: SEVERITY.thinkingOnly,
      message:
        `Задача идёт ${Math.round(snapshot.elapsedMs / 60_000)} мин и всё это время только ` +
        `размышляет: ни одного вызова инструмента и ни одного видимого сообщения ` +
        `(пульсов размышления ${snapshot.thinkingTokenEvents}). Процесс жив, но к действиям пока ` +
        `не перешёл — опросите get_task_status с process_id "${processId}" ещё раз, а при повторе ` +
        `той же картины обсудите с пользователем отмену и более конкретную постановку.`,
      details: {
        elapsed_ms: snapshot.elapsedMs,
        thinking_token_events: snapshot.thinkingTokenEvents,
        estimated_thinking_tokens: snapshot.estimatedThinkingTokens,
        assistant_events: snapshot.assistantEvents,
      },
    });
  }

  // Список строится в порядке убывания важности, так что сортировка обычно
  // ничего не меняет. Она нужна как страховка: сортировка в V8 стабильна,
  // поэтому при равной важности сохраняется порядок объявления выше, и выбор
  // главного паттерна остаётся детерминированным при любой правке порядка.
  return found.sort((a, b) => b.severity - a.severity);
}

/**
 * Главный паттерн задачи — то, что показывает next_step.
 *
 * Отдельная функция от detectPatterns: фраза в отчёте нужна ровно одна, но
 * полный список полезен для логов и для тестов, и терять его не хочется.
 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const patterns = detectPatterns(input);
  const main = patterns[0];
  if (main === undefined) {
    return { pattern: null, severity: 0, message: null, details: {}, patterns };
  }
  return {
    pattern: main.code,
    severity: main.severity,
    message: main.message,
    details: main.details,
    patterns,
  };
}
