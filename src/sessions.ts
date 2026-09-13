import { createHash } from "node:crypto";
import { OPEN_QUESTIONS_HEADING } from "./prompts.js";

/**
 * Состояние сессии Claude Code в протоколе «план → одобрение → выполнение».
 *
 * needs_clarification — план содержит открытые вопросы, одобрять нечего;
 * planned   — план получен, но не одобрен;
 * approved  — план явно одобрен через approve_plan;
 * executing — выполнение идёт прямо сейчас, одобрение занято;
 * executed  — план выполнен, для новой работы нужен новый цикл.
 *
 * Состояние executing существует, чтобы два параллельных execute_task не прошли
 * проверку одновременно: между допуском и завершением процесса проходят минуты.
 */
export type SessionState =
  | "needs_clarification"
  | "planned"
  | "approved"
  | "executing"
  | "executed";

export interface SessionRecord {
  sessionId: string;
  state: SessionState;
  /** Канонический каталог, для которого строился план. */
  projectDir: string;
  /** Короткий хеш текста плана — его требует approve_plan. */
  planDigest: string;
  plannedAt: number;
  approvedAt: number | null;
  executedAt: number | null;
  updatedAt: number;
}

/** Отказ в допуске к выполнению. Преобразуется в текст для вызывающего агента. */
export class ApprovalError extends Error {}

/** Короткий отпечаток плана: sha256, первые 12 hex-символов. */
export function computeDigest(planText: string): string {
  return createHash("sha256").update(planText, "utf8").digest("hex").slice(0, 12);
}

const isWindows = process.platform === "win32";

function samePath(a: string, b: string): boolean {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly retentionMs: number) {}

  get(sessionId: string): SessionRecord | undefined {
    const record = this.sessions.get(sessionId);
    if (record && this.isExpired(record)) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return record;
  }

  private isExpired(record: SessionRecord): boolean {
    // Выполняющуюся задачу не выбрасываем, даже если она идёт дольше TTL.
    if (record.state === "executing") return false;
    return Date.now() - record.updatedAt > this.retentionMs;
  }

  /**
   * Фиксирует успешный план.
   *
   * Всегда перезаписывает состояние в planned: повторный plan_task по уже
   * одобренной сессии обязан сбрасывать одобрение, иначе можно было бы одобрить
   * один план, перепланировать сессию на другой и выполнить его без согласия.
   */
  recordPlanned(
    sessionId: string,
    projectDir: string,
    planText: string,
    hasOpenQuestions = false,
  ): SessionRecord {
    const now = Date.now();
    const record: SessionRecord = {
      sessionId,
      // План с открытыми вопросами одобрять нечего: сначала уточнение.
      state: hasOpenQuestions ? "needs_clarification" : "planned",
      projectDir,
      planDigest: computeDigest(planText),
      plannedAt: now,
      approvedAt: null,
      executedAt: null,
      updatedAt: now,
    };
    this.sessions.set(sessionId, record);
    this.prune();
    return record;
  }

  /** Переводит planned → approved. Требует совпадения отпечатка плана. */
  approve(sessionId: string, planDigest: string): SessionRecord {
    const record = this.get(sessionId);
    if (!record) {
      throw new ApprovalError(
        `сессия ${sessionId} неизвестна мосту. Одобрить можно только план, полученный через ` +
          `plan_task на этом же сервере. Если сервер перезапускался, повторите plan_task.`,
      );
    }

    const given = planDigest.trim().toLowerCase();
    if (given !== record.planDigest) {
      throw new ApprovalError(
        `plan_digest не совпадает с планом сессии ${sessionId}. Возьмите значение plan_digest ` +
          `из ответа plan_task и передайте его без изменений.`,
      );
    }

    if (record.state === "needs_clarification") {
      throw new ApprovalError(
        `план сессии ${sessionId} содержит открытые вопросы — одобрять его нельзя. ` +
          `Раздел «${OPEN_QUESTIONS_HEADING}» в тексте плана перечисляет, чего не хватает. ` +
          `Уточните это у пользователя и вызовите plan_task заново с дополненной формулировкой задачи.`,
      );
    }
    if (record.state === "executing") {
      throw new ApprovalError(
        `по сессии ${sessionId} уже идёт выполнение. Дождитесь завершения через get_task_status.`,
      );
    }
    if (record.state === "executed") {
      throw new ApprovalError(
        `план сессии ${sessionId} уже выполнен. Для новой работы вызовите plan_task заново — ` +
          `это создаст новый план, который нужно одобрить отдельно.`,
      );
    }

    // Повторное одобрение с тем же отпечатком безвредно — не считаем ошибкой.
    if (record.state === "planned") {
      record.state = "approved";
      record.approvedAt = Date.now();
    }
    record.updatedAt = Date.now();
    return record;
  }

  /**
   * Единственная точка допуска к выполнению.
   *
   * При успехе занимает одобрение (approved → executing), чтобы параллельный
   * вызов не прошёл проверку повторно.
   */
  beginExecution(sessionId: string, projectDir: string): SessionRecord {
    const record = this.get(sessionId);

    if (!record) {
      throw new ApprovalError(
        `сессия ${sessionId} не проходила согласование. Выполнение возможно только по плану: ` +
          `сначала plan_task, затем approve_plan. Если сервер перезапускался или прошло больше ` +
          `суток, состояние сессии утрачено — пройдите цикл заново.`,
      );
    }

    if (!samePath(record.projectDir, projectDir)) {
      throw new ApprovalError(
        `план сессии ${sessionId} строился для каталога ${record.projectDir}, а выполнение ` +
          `запрошено в ${projectDir}. Одобрение действует только для своего проекта.`,
      );
    }

    switch (record.state) {
      case "needs_clarification":
        throw new ApprovalError(
          `план сессии ${sessionId} содержит открытые вопросы и не может быть выполнен. ` +
            `Уточните перечисленное в разделе «${OPEN_QUESTIONS_HEADING}» и вызовите plan_task заново.`,
        );
      case "planned":
        throw new ApprovalError(
          `план сессии ${sessionId} получен, но не одобрен. Покажите его пользователю и вызовите ` +
            `approve_plan с session_id "${sessionId}" и plan_digest "${record.planDigest}".`,
        );
      case "executing":
        throw new ApprovalError(
          `по сессии ${sessionId} уже идёт выполнение. Дождитесь результата через get_task_status.`,
        );
      case "executed":
        throw new ApprovalError(
          `план сессии ${sessionId} уже выполнен. Повторный запуск по тому же одобрению запрещён: ` +
            `вызовите plan_task для новой задачи и одобрите новый план.`,
        );
      case "approved":
        record.state = "executing";
        record.updatedAt = Date.now();
        return record;
    }
  }

  /**
   * Завершает выполнение.
   *
   * При успехе одобрение считается израсходованным, при сбое — возвращается,
   * чтобы транзиентная ошибка (таймаут, 401) не заставляла проходить весь цикл заново.
   */
  finishExecution(sessionId: string, ok: boolean): SessionRecord | undefined {
    const record = this.sessions.get(sessionId);
    if (!record || record.state !== "executing") return record;

    record.state = ok ? "executed" : "approved";
    record.executedAt = ok ? Date.now() : null;
    record.updatedAt = Date.now();
    this.prune();
    return record;
  }

  /** Чистим протухшие записи. */
  private prune(): void {
    for (const [id, record] of this.sessions) {
      if (this.isExpired(record)) this.sessions.delete(id);
    }
  }
}
