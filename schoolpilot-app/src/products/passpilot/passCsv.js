function formulaSafeCsvValue(value) {
  const text = String(value ?? '');
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

export function encodePassPilotCsv(rows) {
  return '\uFEFF' + rows
    .map((row) => row
      .map((field) => `"${formulaSafeCsvValue(field).replace(/"/g, '""')}"`)
      .join(','))
    .join('\r\n');
}
