"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FACECLAW_DIR = path.resolve(__dirname, "..");
const G2FLASH_DIR = process.env.G2FLASH_DIR
  ? path.resolve(process.env.G2FLASH_DIR)
  : path.resolve(FACECLAW_DIR, "..", "g2flash");

const FACECLAW_PATCH_TS = path.join(
  FACECLAW_DIR,
  "app",
  "g2",
  "firmware",
  "cfw-patches.ts"
);

const FACECLAW_ASSET = path.join(
  FACECLAW_DIR,
  "App_Resources",
  "Android",
  "src",
  "main",
  "assets",
  "g2_2.2.6.10_cfw.bin"
);

const G2_PATCH_JSON = path.join(
  G2FLASH_DIR,
  "patches",
  "cfw_patches.json"
);

const G2_BUILD_SCRIPT = path.join(
  G2FLASH_DIR,
  "build_cfw.sh"
);

function fail(message) {
  throw new Error(`FIRMWARE GUARD: ${message}`);
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex").toLowerCase();
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) {
    fail(`${label} is missing: ${file}`);
  }
}

function normalize(value) {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalize(value[key]);
    }
    return result;
  }

  return value;
}

function semanticallyEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function loadFaceclawPatchSet() {
  requireFile(FACECLAW_PATCH_TS, "Faceclaw runtime patch set");

  const text = fs.readFileSync(FACECLAW_PATCH_TS, "utf8");
  const marker =
    "export const CFW_PATCH_SET: FirmwarePatchSet = ";

  const start = text.indexOf(marker);

  if (start < 0) {
    fail("cannot locate CFW_PATCH_SET in cfw-patches.ts");
  }

  let jsonText = text
    .slice(start + marker.length)
    .trim();

  jsonText = jsonText.replace(/;\s*$/, "");

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    fail(`cannot parse CFW_PATCH_SET: ${error.message}`);
  }
}

function loadG2State(options = {}) {
  const requireBinary = options.requireBinary === true;

  if (!fs.existsSync(G2_PATCH_JSON)) {
    if (process.env.G2FLASH_DIR) {
      fail(
        `G2FLASH_DIR was explicitly set, but cfw_patches.json is missing: ${G2_PATCH_JSON}`
      );
    }

    return null;
  }

  let raw;

  try {
    raw = JSON.parse(
      fs.readFileSync(G2_PATCH_JSON, "utf8")
    );
  } catch (error) {
    fail(`cannot parse g2flash patch JSON: ${error.message}`);
  }

  const expected = {
    base: raw.base,
    baseSha256: raw.base_sha256,
    outputSha256: raw.output_sha256,
    patches: raw.patches,
  };

  if (
    typeof expected.outputSha256 !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(expected.outputSha256)
  ) {
    fail("g2flash output SHA256 is invalid");
  }

  expected.baseSha256 =
    String(expected.baseSha256).toLowerCase();

  expected.outputSha256 =
    String(expected.outputSha256).toLowerCase();

  requireFile(G2_BUILD_SCRIPT, "g2flash build_cfw.sh");

  const buildScript = fs.readFileSync(
    G2_BUILD_SCRIPT,
    "utf8"
  );

  const pinMatch = buildScript.match(
    /^\s*OUT_SHA256\s*=\s*["']([0-9a-fA-F]{64})["']/m
  );

  if (!pinMatch) {
    fail("cannot locate OUT_SHA256 in g2flash/build_cfw.sh");
  }

  const buildPin = pinMatch[1].toLowerCase();

  if (buildPin !== expected.outputSha256) {
    fail(
      "g2flash build pin does not match cfw_patches.json\n" +
      `  build pin: ${buildPin}\n` +
      `  patch JSON: ${expected.outputSha256}`
    );
  }

  if (
    typeof expected.base === "string" &&
    expected.base.length > 0
  ) {
    const basePath = path.join(
      G2FLASH_DIR,
      expected.base
    );

    if (fs.existsSync(basePath)) {
      const baseHash = sha256File(basePath);

      if (baseHash !== expected.baseSha256) {
        fail(
          "g2flash stock base hash mismatch\n" +
          `  file: ${baseHash}\n` +
          `  JSON: ${expected.baseSha256}`
        );
      }
    }
  }

  const outputName = String(expected.base).replace(
    /\.bin$/i,
    "_cfw.bin"
  );

  const outputPath = path.join(
    G2FLASH_DIR,
    outputName
  );

  if (fs.existsSync(outputPath)) {
    const outputHash = sha256File(outputPath);

    if (outputHash !== expected.outputSha256) {
      fail(
        "g2flash CFW binary does not match cfw_patches.json\n" +
        `  binary: ${outputHash}\n` +
        `  JSON:   ${expected.outputSha256}`
      );
    }
  } else if (requireBinary) {
    fail(
      `g2flash CFW binary is required for sync but missing: ${outputPath}`
    );
  }

  return {
    expected,
    outputPath,
  };
}

function renderFaceclawPatchSet(patchSet) {
  const version = String(patchSet.base)
    .replace(/^g2_/, "")
    .replace(/\.bin$/i, "");

  return `// AUTO-GENERATED from g2flash/patches/cfw_patches.json -- do not edit by hand.
// Regenerate with: npm run firmware:sync
// Turns the stock G2 ${version} image into the Faceclaw custom firmware.

export type FirmwarePatchOp = {
  offset: number;
  old: string;
  new: string;
  desc?: string;
};

export type FirmwarePatchSet = {
  base: string;
  baseSha256: string;
  outputSha256: string;
  patches: FirmwarePatchOp[];
};

export const CFW_PATCH_SET: FirmwarePatchSet = ${JSON.stringify(
    patchSet,
    null,
    2
  )};
`;
}

function verify() {
  requireFile(
    FACECLAW_ASSET,
    "Faceclaw bundled firmware asset"
  );

  const localPatchSet =
    loadFaceclawPatchSet();

  const localOutputHash =
    String(localPatchSet.outputSha256).toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(localOutputHash)) {
    fail(
      "Faceclaw CFW_PATCH_SET.outputSha256 is invalid"
    );
  }

  const assetHash =
    sha256File(FACECLAW_ASSET);

  if (assetHash !== localOutputHash) {
    fail(
      "FACECLAW INTERNAL MISMATCH\n" +
      "The binary asset and runtime patch set describe different firmware.\n" +
      `  asset:       ${assetHash}\n` +
      `  runtime set: ${localOutputHash}\n` +
      "Run: npm run firmware:sync"
    );
  }

  const g2 = loadG2State();

  if (g2) {
    if (
      !semanticallyEqual(
        localPatchSet,
        g2.expected
      )
    ) {
      fail(
        "CROSS-REPO MISMATCH\n" +
        "Faceclaw cfw-patches.ts is not the same patch set as g2flash/cfw_patches.json.\n" +
        "Run: npm run firmware:sync"
      );
    }

    if (
      assetHash !==
      g2.expected.outputSha256
    ) {
      fail(
        "CROSS-REPO BINARY MISMATCH\n" +
        `  Faceclaw asset: ${assetHash}\n` +
        `  g2flash output: ${g2.expected.outputSha256}\n` +
        "Run: npm run firmware:sync"
      );
    }

    console.log(
      "PASS: g2flash JSON == Faceclaw runtime patch set."
    );
    console.log(
      "PASS: g2flash output hash == Faceclaw firmware asset."
    );
    console.log(
      `Firmware SHA256: ${assetHash}`
    );
    console.log(
      `Patch count: ${localPatchSet.patches.length}`
    );
    return {
      hash: assetHash,
      crossRepo: true,
    };
  }

  console.log(
    "PASS: Faceclaw runtime patch set == Faceclaw firmware asset."
  );
  console.log(
    "NOTE: sibling g2flash checkout was not found; cross-repo verification was skipped."
  );
  console.log(
    `Firmware SHA256: ${assetHash}`
  );

  return {
    hash: assetHash,
    crossRepo: false,
  };
}

function sync() {
  const g2 = loadG2State({
    requireBinary: true,
  });

  if (!g2) {
    fail(
      "cannot sync because sibling g2flash checkout was not found"
    );
  }

  const rendered =
    renderFaceclawPatchSet(g2.expected);

  fs.mkdirSync(
    path.dirname(FACECLAW_PATCH_TS),
    { recursive: true }
  );

  fs.writeFileSync(
    FACECLAW_PATCH_TS,
    rendered,
    {
      encoding: "utf8",
    }
  );

  fs.mkdirSync(
    path.dirname(FACECLAW_ASSET),
    { recursive: true }
  );

  fs.copyFileSync(
    g2.outputPath,
    FACECLAW_ASSET
  );

  console.log(
    "Synced Faceclaw runtime patch set from g2flash."
  );
  console.log(
    "Synced Faceclaw binary asset from g2flash."
  );

  return verify();
}

if (require.main === module) {
  try {
    if (process.argv.includes("--sync")) {
      sync();
    } else {
      verify();
    }
  } catch (error) {
    console.error("");
    console.error(
      error && error.stack
        ? error.stack
        : String(error)
    );
    console.error("");
    process.exit(1);
  }
}

module.exports = {
  verify,
  sync,
};