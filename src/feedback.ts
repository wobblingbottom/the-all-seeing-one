import type { DatabaseSync } from "node:sqlite";

export function feedbackStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS public_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('bug', 'suggestion')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS public_feedback_author ON public_feedback(user_id, created_at);`);
  const fields = "id, username, type, title, description, created_at";
  return {
    list(page: number) {
      const total = Number((db.prepare("SELECT COUNT(*) AS total FROM public_feedback").get() as { total: number }).total);
      const totalPages = Math.max(1, Math.ceil(total / 20));
      page = Math.min(Math.max(1, page), totalPages);
      return { items: db.prepare(`SELECT ${fields} FROM public_feedback ORDER BY id DESC LIMIT 20 OFFSET ?`).all((page - 1) * 20), page, totalPages };
    },
    create(user: { id: string; username: string }, body: unknown, now = Date.now()) {
      const input = body as Record<string, unknown> | null;
      if (!input || (input.type !== "bug" && input.type !== "suggestion")) throw new Error("Choose Bug report or Suggestion.");
      if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 120) throw new Error("Enter a title of 1-120 characters.");
      if (typeof input.description !== "string" || !input.description.trim() || input.description.trim().length > 4000) throw new Error("Enter details of 1-4000 characters.");
      const recent = db.prepare("SELECT created_at FROM public_feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(user.id) as { created_at: number } | undefined;
      if (recent && now - recent.created_at < 60_000) throw new Error("Please wait a minute before submitting again.");
      const result = db.prepare("INSERT INTO public_feedback (user_id, username, type, title, description, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(user.id, user.username, input.type, input.title.trim(), input.description.trim(), now);
      return db.prepare(`SELECT ${fields} FROM public_feedback WHERE id = ?`).get(result.lastInsertRowid);
    }
  };
}
