export function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(id);
}
