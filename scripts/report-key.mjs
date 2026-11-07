import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const NONCE_BYTES = 12;
const NOT_OPENED = 3;
const EPHEMERAL_BYTES = 32;
const ORIGIN = process.env.FOLIO_ORIGIN ?? "https://tisty.cl";
const MANIFEST_SIZE_AT = 4;
const MANIFEST_AT = 8;
const CASE_TOKEN = /#caso\.([A-Za-z0-9_-]{43})/;
const LABELS = { "sealed1.": "folio.report-link.v1", "contact1.": "folio.report-contact.v1" };

const text = (bytes) => Buffer.from(bytes).toString("base64url");
const shown = (said) => said.replace(/\p{C}/gu, (one) => `\\u{${one.codePointAt(0).toString(16)}}`);

const create = async (file) => {
  const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const secret = text(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  writeFileSync(file, `${secret}\n`, { flag: "wx", mode: 0o600 });
  console.log(text(await crypto.subtle.exportKey("raw", pair.publicKey)));
};

const opened = async (file, id, sealedLink) => {
  const secret = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
  const own = await crypto.subtle.importKey("pkcs8", secret, "X25519", true, ["deriveBits"]);
  const { x } = await crypto.subtle.exportKey("jwk", own);
  const prefix = Object.keys(LABELS).find((one) => sealedLink.startsWith(one));
  if (!prefix) throw new Error("this is not something sealed for the operator");
  const sealed = Buffer.from(sealedLink.slice(prefix.length), "base64url");
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
      info: Buffer.from(LABELS[prefix]),
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
  return Buffer.from(opened).toString();
};

const open = async (file, id, sealedLink) => {
  console.error("What the seal brings, written by whoever reported and not checked:");
  console.log(shown(await opened(file, id, sealedLink)));
};

const envelopeOf = async (id, caseLink) => {
  const token = caseLink ? CASE_TOKEN.exec(caseLink)?.[1] : undefined;
  if (caseLink && !token) throw new Error("that is not a case link");
  const response = await fetch(`${ORIGIN}/api/v1/${token ? "cases" : "docs"}/${id}`, {
    ...(token ? { headers: { "Folio-Case": token } } : {}),
  });
  if (response.status === 403 && !token) {
    throw new Error("the document is blocked: make a link to verify in the panel, and add it as the last argument");
  }
  if (!response.ok) throw new Error(`the document could not be brought: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const manifestOf = (envelope) => {
  const size = envelope.readUInt32BE(MANIFEST_SIZE_AT);
  return JSON.parse(envelope.subarray(MANIFEST_AT, MANIFEST_AT + size).toString());
};

const keyOpens = (key, { head, commitment }) => {
  if (!head || !commitment) return false;
  const expected = createHmac("sha256", Buffer.from(key, "base64url"))
    .update("tisty-envelope-commit")
    .update(Buffer.from(head, "base64url"))
    .digest();
  const said = Buffer.from(commitment, "base64url");
  return said.length === expected.length && timingSafeEqual(said, expected);
};

const check = async (file, id, sealedLink, caseLink) => {
  const key = (await opened(file, id, sealedLink)).split("#")[1];
  if (!key) {
    console.log("It does not open it: what the seal brings is no key to this document.");
    process.exitCode = NOT_OPENED;
    return;
  }
  const opens = keyOpens(key, manifestOf(await envelopeOf(id, caseLink)));
  console.log(opens ? "The key opens this document. Nothing of it was read." : "It does not open it: the key is not this document's.");
  if (!opens) process.exitCode = NOT_OPENED;
};

const [command, file, ...rest] = process.argv.slice(2);
if (command === "new" && file) await create(file);
else if (command === "open" && file && rest.length === 2) await open(file, rest[0], rest[1]);
else if (command === "check" && file && (rest.length === 2 || rest.length === 3)) await check(file, ...rest);
else {
  console.error("usage: report-key.mjs new <file> | open <file> <id> <sealed> | check <file> <id> <sealedLink> [caseLink]");
  process.exit(1);
}
