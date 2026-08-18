import type { Finding, Review } from "@deep-review/shared";
import { useCallback, useEffect, useState } from "react";
import { createReview, listFindings, listReviews } from "./api";

export function App() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selected, setSelected] = useState<Review | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listReviews().then(setReviews).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!selected) {
      setFindings([]);
      return;
    }
    listFindings(selected.id)
      .then(setFindings)
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await createReview({
        title: String(data.get("title")),
        repo: String(data.get("repo")),
        baseRef: String(data.get("baseRef")),
        headRef: String(data.get("headRef")),
      });
      form.reset();
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <h1>Deep Review</h1>
      {error && <p className="error">{error}</p>}

      <section>
        <h2>New review</h2>
        <form onSubmit={onSubmit} className="new-review">
          <input name="title" placeholder="Title" required />
          <input name="repo" placeholder="owner/repo" required />
          <input name="baseRef" placeholder="base ref" defaultValue="main" required />
          <input name="headRef" placeholder="head ref" required />
          <button type="submit">Create</button>
        </form>
      </section>

      <section>
        <h2>Reviews</h2>
        {reviews.length === 0 ? (
          <p className="empty">No reviews yet.</p>
        ) : (
          <ul className="review-list">
            {reviews.map((review) => (
              <li key={review.id}>
                <button
                  className={selected?.id === review.id ? "selected" : ""}
                  onClick={() => setSelected(review)}
                >
                  <strong>{review.title}</strong>{" "}
                  <span className="meta">
                    {review.repo} · {review.baseRef}…{review.headRef} ·{" "}
                    {review.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section>
          <h2>Findings for “{selected.title}”</h2>
          {findings.length === 0 ? (
            <p className="empty">No findings yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Location</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.id}>
                    <td className={`severity severity-${f.severity}`}>{f.severity}</td>
                    <td>
                      <code>
                        {f.file}:{f.line}
                      </code>
                    </td>
                    <td>{f.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
