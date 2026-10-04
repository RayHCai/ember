/** `Array#toSorted`, which Hermes does not implement: a sorted copy, `items` left untouched. */
export function sorted<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy, never the caller's array
    return [...items].sort(compare);
}
