import { readFileSync, writeFileSync } from "node:fs";

const NONCE_BYTES = 12;
const EPHEMERAL_BYTES = 32;
const PREFIX = "sealed1.";

const text = (bytes) => Buffer.from(bytes).toString("base64url");

const create = async (file) => {
  const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const secret = text(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  writeFileSync(file, `${secret}\n`, { flag: "wx", mode: 0o600 });
  console.log(text(await crypto.subtle.exportKey("raw", pair.publicKey)));
};

const open = async (file, id, sealedLink) => {
  const secret = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
  const own = await crypto.subtle.importKey("pkcs8", secret, "X25519", true, ["deriveBits"]);
  const { x } = await crypto.subtle.exportKey("jwk", own);
  const sealed = Buffer.from(sealedLink.slice(PREFIX.length), "base64url");
  const ephemeral = sealed.subarray(0, EPHEMERAL_BYTES);
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: await crypto.subtle.importKey("raw", ephemeral, "X25519", false, []) },
    own,
    256,
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Buffer.concat([ephemeral, Buffer.from(x, "base64url")]),
      info: Buffer.from("folio.report-link.v1"),
    },
    await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const opened = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: sealed.subarray(EPHEMERAL_BYTES, EPHEMERAL_BYTES + NONCE_BYTES),
      additionalData: Buffer.from(id),
    },
    key,
    sealed.subarray(EPHEMERAL_BYTES + NONCE_BYTES),
  );
  console.log(Buffer.from(opened).toString());
};

const [command, file, ...rest] = process.argv.slice(2);
if (command === "new" && file) await create(file);
else if (command === "open" && file && rest.length === 2) await open(file, rest[0], rest[1]);
else {
  console.error("usage: report-key.mjs new <file> | open <file> <id> <sealedLink>");
  process.exit(1);
}
