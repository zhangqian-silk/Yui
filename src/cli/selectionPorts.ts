export type SelectionPorts = Readonly<{
  call(
    method: string,
    params: Readonly<Record<string, unknown>>
  ): unknown | PromiseLike<unknown>;
}>;
