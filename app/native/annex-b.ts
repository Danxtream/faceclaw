export function splitAnnexBNals(data: Uint8Array): Uint8Array[] {
  const starts: Array<{ offset: number; prefix: number }> = [];

  for (let i = 0; i + 3 < data.length; i++) {
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    ) {
      starts.push({ offset: i, prefix: 4 });
      i += 3;
      continue;
    }

    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1
    ) {
      starts.push({ offset: i, prefix: 3 });
      i += 2;
    }
  }

  if (starts.length === 0) {
    throw new Error("No Annex-B start codes found");
  }

  const nals: Uint8Array[] = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end =
      i + 1 < starts.length
        ? starts[i + 1]!.offset
        : data.length;

    const nalStart = start.offset + start.prefix;

    if (end <= nalStart) {
      continue;
    }

    nals.push(data.slice(nalStart, end));
  }

  return nals;
}
