/**
 * Collect raw HTTP request bytes and decode UTF-8 once, preserving characters
 * split across socket reads. Reject with BODY_TOO_LARGE above the byte cap.
 */
function readBody(req, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      size += bytes.length;
      if (size > maxBytes) {
        done = true;
        const err = new Error("Request body too large");
        err.code = "BODY_TOO_LARGE";
        reject(err);
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("Request body aborted")));
  });
}

module.exports = { readBody };
