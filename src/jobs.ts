import { randomUUID } from "node:crypto";
import type { HookBridge } from "./hookBridge.js";
import type { ParsedResult } from "./parser.js";
import type { JobProgress } from "./progress.js";

export type JobStatus = "running" | "done" | "failed" | "timeout" | "canceled";

export interface Job {
  processId: string;
  tool: "plan_task" | "execute_task";
  projectDir: string;
  permissionMode: string;
  /** Значение, ушедшее в --model. null — флаг не передавался. */
  model: string | null;
  taskPreview: string;
  /** session_id, переданный на вход (если задача продолжает существующую сессию). */
  requestedSessionId: string | null;
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  pid: number | undefined;
  result: ParsedResult | null;
  exitCode: number | null;
  cancel: () => void;
  /** Разрешается при завершении задачи; используется для ожидания с таймаутом. */
  completion: Promise<void>;
  /**
   * Мост HTTP-хуков этой задачи. null — хуки выключены или это plan_task.
   *
   * После завершения задачи перестаёт слушать порт, но карту запросов хранит:
   * get_task_status показывает историю разрешений и по завершённой задаче.
   */
  bridge: HookBridge | null;
  /**
   * Живое состояние задачи, собранное по потоку stream-json.
   *
   * Экземпляр обязан существовать раньше Job: колбэк уходит в runner.run(), а
   * тот стартует процесс до создания Job. Поэтому поле не входит в Omit у
   * create — компилятор требует передать готовый объект, а не собирать его
   * позже. При streamEvents: false объект есть, но остаётся пустым.
   */
  progress: JobProgress;
}

const MAX_FINISHED = 100;

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly retentionMs: number) {}

  create(
    init: Omit<
      Job,
      "processId" | "status" | "startedAt" | "finishedAt" | "result" | "exitCode"
    >,
  ): Job {
    const job: Job = {
      ...init,
      processId: randomUUID(),
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      exitCode: null,
    };
    this.jobs.set(job.processId, job);
    return job;
  }

  get(processId: string): Job | undefined {
    return this.jobs.get(processId);
  }

  complete(job: Job, status: JobStatus, result: ParsedResult | null, exitCode: number | null): void {
    job.status = status;
    job.result = result;
    job.exitCode = exitCode;
    job.finishedAt = Date.now();
    this.prune();
  }

  /** Чистим завершённые задачи: по возрасту и по количеству. */
  private prune(): void {
    const now = Date.now();
    const finished: Job[] = [];

    for (const job of this.jobs.values()) {
      if (job.finishedAt === null) continue;
      if (now - job.finishedAt > this.retentionMs) {
        this.jobs.delete(job.processId);
      } else {
        finished.push(job);
      }
    }

    if (finished.length > MAX_FINISHED) {
      finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
      for (const job of finished.slice(0, finished.length - MAX_FINISHED)) {
        this.jobs.delete(job.processId);
      }
    }
  }

  /** Останавливает все активные задачи — вызывается при завершении сервера. */
  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "running") job.cancel();
    }
  }
}

/**
 * Почему ожидание задачи закончилось.
 *
 * pending_permission — вышли досрочно: у моста изменился состав запросов,
 * ждущих решения оператора. Отдельная причина нужна, чтобы «задача ещё идёт,
 * но ответ пришёл раньше срока» не выглядело как обычный таймаут.
 */
export type WaitReason = "completed" | "timeout" | "pending_permission";

export interface WaitOptions {
  /**
   * Просыпаться, когда у моста появился новый запрос на разрешение или
   * существующий исчерпал бюджет повторов.
   *
   * Намеренно не «на любой прогресс задачи»: промежуточных событий у дочернего
   * CLI десятки в секунду, и ожидание выродилось бы в горячий опрос, потеряв
   * смысл wait_seconds — «припарковаться и получить ответ».
   */
  wakeOnPendingPermission?: boolean;
}

/**
 * Ждёт завершения задачи не дольше указанного времени.
 *
 * @returns почему ожидание закончилось.
 */
export async function waitForJob(
  job: Job,
  waitSeconds: number,
  opts: WaitOptions = {},
): Promise<WaitReason> {
  if (job.status !== "running") return "completed";
  if (waitSeconds <= 0) return "timeout";

  const bridge = opts.wakeOnPendingPermission ? job.bridge : null;
  // Ревизию читаем ДО подписки: запрос, возникший между чтением и подпиской,
  // иначе провисел бы до конца таймаута — ровно та гонка, из-за которой
  // отдельного счётчика и не хватало.
  const revisionBefore = bridge?.pendingRevision ?? 0;

  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    const races: Array<Promise<WaitReason>> = [
      job.completion.then(() => "completed" as const),
      new Promise<WaitReason>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), waitSeconds * 1000);
      }),
    ];

    if (bridge) {
      races.push(
        new Promise<WaitReason>((resolve) => {
          unsubscribe = bridge.onPendingChange(() => resolve("pending_permission"));
        }),
      );
      // Перепроверка уже под подпиской закрывает окно между чтением и ею.
      if (bridge.pendingRevision !== revisionBefore) return "pending_permission";
    }

    return await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
  }
}
