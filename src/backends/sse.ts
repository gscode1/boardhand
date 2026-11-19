// A small server-sent-events reader. The `id` is not sticky as in a browser's EventSource: a `live` event sent without
// an id must not inherit the previous entry's id, because the id is the resume cursor.

export type SseEvent = { id?: string; event: string; data: string };

/** Incremental parser: chunks may split anywhere. A block without `data:` dispatches nothing. */
export class SseParser {
  #buffer = "";
  #id: string | undefined;
  #event = "";
  #data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const events: SseEvent[] = [];
    // A line ends at LF, CR or CRLF. A trailing CR waits for the next chunk, which may begin with its LF.
    const lines = this.#buffer.split(/\r\n|\n|\r(?!$)/);
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      const dispatched = this.#line(line);
      if (dispatched !== undefined) events.push(dispatched);
    }
    return events;
  }

  #line(line: string): SseEvent | undefined {
    if (line === "") return this.#dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.#data.push(value);
    else if (field === "event") this.#event = value;
    else if (field === "id") this.#id = value;
    return undefined;
  }

  #dispatch(): SseEvent | undefined {
    const data = this.#data;
    const event: SseEvent = { event: this.#event === "" ? "message" : this.#event, data: data.join("\n") };
    if (this.#id !== undefined) event.id = this.#id;
    this.#id = undefined;
    this.#event = "";
    this.#data = [];
    return data.length === 0 ? undefined : event;
  }
}

/** Yields the events of a response body until it ends or `signal` aborts; the body is always cancelled. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (result.done) return;
      yield* parser.push(decoder.decode(result.value, { stream: true }));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
