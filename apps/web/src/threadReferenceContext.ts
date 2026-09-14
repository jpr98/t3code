import * as Schema from "effect/Schema";

/** Draft-side payload behind a thread chip: the referenced thread's id and its title at insert time. */
export const ThreadReferenceContextSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
});

export interface ThreadReferenceContext {
  readonly id: string;
  readonly title: string;
}
