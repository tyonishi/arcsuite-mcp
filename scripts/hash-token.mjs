import { createHash } from "node:crypto";
const token = process.argv[2];
if (!token) { console.error("usage: node scripts/hash-token.mjs <token>"); process.exit(2); }
console.log(createHash("sha256").update(token).digest("hex"));
