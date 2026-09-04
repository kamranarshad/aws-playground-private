const fs = require('fs');
const path = require('path');

// Write-then-rename. rename(2) is atomic within a filesystem, so a reader
// (or a crash) sees either the entire old file or the entire new one, never
// a half-written mix. The playground's registry and history are the user's
// only copy of this data -- a torn write there is unrecoverable, which is
// why store.load() carries a .corrupt quarantine path at all.
function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (err) {
    // Leaving the temp file behind would make the next writeFileAtomic look
    // like it half-succeeded, and would slowly litter the data dir.
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

module.exports = { writeFileAtomic };
