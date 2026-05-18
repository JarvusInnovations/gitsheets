/**
 * Read all of process.stdin to a string. Resolves to '' if stdin is a TTY
 * (interactive — nothing to read) or when the GITSHEETS_AXI_NO_STDIN env is
 * set (test-mode opt-out to avoid hangs in in-process test runners).
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  if (process.env['GITSHEETS_AXI_NO_STDIN'] === '1') return '';
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
