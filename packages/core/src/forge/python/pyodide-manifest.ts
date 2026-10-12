/**
 * Pinned Pyodide distribution for the `wasm` Python backend (Python spec §8.1, PD7). A TypeScript
 * constant, not JSON, because `tsc` does not copy JSON into `dist`. Every file carries its
 * SHA-256 and size; `alisio analysis setup --wasm` is the only code that fetches them.
 *
 * - `pyodide` files come from the official jsDelivr mirror of the 314.0.7 release; the hashes of
 *   the wheels are the ones of `pyodide-lock.json`, and the core files were checked against the
 *   mirror (Phase P0, 2026-10-12).
 * - `pypi` files are pure wheels that the Pyodide lock does not ship; their hashes are the ones
 *   PyPI publishes. A raw wheel URL does not resolve dependencies, so `depends` lists them.
 * - `sqlite3` is part of the standard library build and is deliberately not listed.
 */
export const PYODIDE_VERSION = "314.0.7";
export const PYTHON_VERSION = "3.14.2";

export type PyodideProfile = "base" | "analysis" | "science";

export interface PyodideFile {
  name: string;
  url: string;
  sha256: string;
  size: number;
  source: "pyodide" | "pypi";
}

export interface PyodidePackage extends PyodideFile {
  /** Direct dependencies by manifest key; they load first. */
  depends: readonly string[];
}

/** Files every profile needs (the runtime itself). */
export const PYODIDE_CORE_FILES: readonly PyodideFile[] = [
  {
    name: "pyodide.mjs",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs",
    sha256: "6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109",
    size: 17931,
    source: "pyodide",
  },
  {
    name: "pyodide.asm.mjs",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.asm.mjs",
    sha256: "f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635",
    size: 1250344,
    source: "pyodide",
  },
  {
    name: "pyodide.asm.wasm",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.asm.wasm",
    sha256: "cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6",
    size: 9598218,
    source: "pyodide",
  },
  {
    name: "python_stdlib.zip",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/python_stdlib.zip",
    sha256: "fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a",
    size: 2545637,
    source: "pyodide",
  },
  {
    name: "pyodide-lock.json",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide-lock.json",
    sha256: "5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010",
    size: 119077,
    source: "pyodide",
  },
];

/** Wheels by manifest key (the distribution name, normalized with dashes). */
export const PYODIDE_PACKAGES: Readonly<Record<string, PyodidePackage>> = {
  numpy: {
    name: "numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf",
    size: 2960568,
    source: "pyodide",
    depends: [],
  },
  pandas: {
    name: "pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "45ff57772cc2f366a8582c7d3097cc4e6676342ecd5a3c08184a43462d5a02ae",
    size: 4177749,
    source: "pyodide",
    depends: ["numpy", "python-dateutil", "pytz"],
  },
  "python-dateutil": {
    name: "python_dateutil-2.9.0.post0-py2.py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/python_dateutil-2.9.0.post0-py2.py3-none-any.whl",
    sha256: "9b13365edf9c188f570baf9c540bbb3029ada2a2dacb9694b3659941693ee9e5",
    size: 229892,
    source: "pyodide",
    depends: ["six"],
  },
  pytz: {
    name: "pytz-2026.1.post1-py2.py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pytz-2026.1.post1-py2.py3-none-any.whl",
    sha256: "b8249d6450146e0b61e6d710dc02ebb35a904796c4c2f97fe87d4ac5872db36a",
    size: 510489,
    source: "pyodide",
    depends: [],
  },
  six: {
    name: "six-1.17.0-py2.py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/six-1.17.0-py2.py3-none-any.whl",
    sha256: "228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42",
    size: 11050,
    source: "pyodide",
    depends: [],
  },
  matplotlib: {
    name: "matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "722857932f8f62eac64f8439af15c94d427f9fb945f9590cd242805c983d2d54",
    size: 6982033,
    source: "pyodide",
    depends: [
      "contourpy",
      "cycler",
      "fonttools",
      "kiwisolver",
      "numpy",
      "packaging",
      "pillow",
      "pyparsing",
      "python-dateutil",
      "pytz",
    ],
  },
  contourpy: {
    name: "contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "0ac15ebf9f820d2d1c3526388aa2818b631cb6c4aae1682efd6b4cc12c1f302c",
    size: 118874,
    source: "pyodide",
    depends: ["numpy"],
  },
  cycler: {
    name: "cycler-0.12.1-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/cycler-0.12.1-py3-none-any.whl",
    sha256: "8ee450085f15b47f78b034d60059af6a3649e98fa5dde073363437742cc0b4ea",
    size: 8321,
    source: "pyodide",
    depends: ["six"],
  },
  fonttools: {
    name: "fonttools-4.62.1-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/fonttools-4.62.1-py3-none-any.whl",
    sha256: "0d1516e073fd0a8d8e6d9af46417b6a26209a42518024a18f7085e72d2599605",
    size: 1152647,
    source: "pyodide",
    depends: [],
  },
  kiwisolver: {
    name: "kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "47781998156721147c128a3c74547d5703e0e3cc454d8203e629339368308a93",
    size: 36616,
    source: "pyodide",
    depends: [],
  },
  packaging: {
    name: "packaging-26.1-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/packaging-26.1-py3-none-any.whl",
    sha256: "565acbbea54da30348b6d68b6a54373e6f777987db9f1db6966b4b3a5060d303",
    size: 95852,
    source: "pyodide",
    depends: [],
  },
  pillow: {
    name: "pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "e29838b7a756e4ee0f27a9cfa9a387ee0dfa2e9dd44be2dd595130b9f9d93ac3",
    size: 1037806,
    source: "pyodide",
    depends: [],
  },
  pyparsing: {
    name: "pyparsing-3.3.2-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyparsing-3.3.2-py3-none-any.whl",
    sha256: "f0dd8225b5f8e945980b400bd465b4b90cb0498a2eede0d9dbea98372f6110c5",
    size: 122781,
    source: "pyodide",
    depends: [],
  },
  jinja2: {
    name: "jinja2-3.1.6-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/jinja2-3.1.6-py3-none-any.whl",
    sha256: "9330ec9cf2241fb8fc352928ea5e72016bf82de1d3d3b71ffea52a093a3ebab8",
    size: 134899,
    source: "pyodide",
    depends: ["markupsafe"],
  },
  markupsafe: {
    name: "markupsafe-3.0.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/markupsafe-3.0.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "b44c364dc0d19e4210ce68ab77833c2b5d608f78fe6966263add4fc1fa667d97",
    size: 9986,
    source: "pyodide",
    depends: [],
  },
  lxml: {
    name: "lxml-6.1.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/lxml-6.1.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "6a0b98f57a538cb6af4868c3499efec2bb52f7ed59fed94b7fbf195d6e40281f",
    size: 2145850,
    source: "pyodide",
    depends: [],
  },
  "typing-extensions": {
    name: "typing_extensions-4.15.0-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/typing_extensions-4.15.0-py3-none-any.whl",
    sha256: "4fec68770a05408e668a4fa53d6bf4f0f684b9dacf820c7c5d6e97d3ad225e29",
    size: 44613,
    source: "pyodide",
    depends: [],
  },
  scipy: {
    name: "scipy-1.18.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/scipy-1.18.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "17ee329a957863516d1bb6a6aaa0c60576fac027e9cd3d43de27f58b5b599b50",
    size: 14029750,
    source: "pyodide",
    depends: ["numpy"],
  },
  patsy: {
    name: "patsy-1.0.2-py2.py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/patsy-1.0.2-py2.py3-none-any.whl",
    sha256: "64e931013dc7c23d2661327531b04c4370605cd439cdee4bb1a55846c5f41771",
    size: 121050,
    source: "pyodide",
    depends: ["numpy", "six"],
  },
  statsmodels: {
    name: "statsmodels-0.14.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/statsmodels-0.14.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "8ee50091810f8ac540a4b94eeba777028cfe8200a78bc5367ea01ad2d6a3a951",
    size: 8162663,
    source: "pyodide",
    depends: ["numpy", "scipy", "pandas", "patsy", "packaging"],
  },
  joblib: {
    name: "joblib-1.5.3-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/joblib-1.5.3-py3-none-any.whl",
    sha256: "fb2860ff70d0b6b43a3df5e3ce52d3a938ad2fcacd80a3f2f3f37e930843e607",
    size: 180317,
    source: "pyodide",
    depends: [],
  },
  threadpoolctl: {
    name: "threadpoolctl-3.6.0-py3-none-any.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/threadpoolctl-3.6.0-py3-none-any.whl",
    sha256: "3521783ffb6bf212e03fb67ec1955af206d6ba7ea09ac21f200875077bbbe7c2",
    size: 18638,
    source: "pyodide",
    depends: [],
  },
  "scikit-learn": {
    name: "scikit_learn-1.8.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    url: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/scikit_learn-1.8.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    sha256: "432f560f54c5283d13e9d7c11dddc8bdf2f15aec326cc1d7314f600786154181",
    size: 4449204,
    source: "pyodide",
    depends: ["scipy", "joblib", "threadpoolctl"],
  },
  openpyxl: {
    name: "openpyxl-3.1.5-py2.py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl",
    sha256: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
    size: 250910,
    source: "pypi",
    depends: ["et-xmlfile"],
  },
  "et-xmlfile": {
    name: "et_xmlfile-2.0.0-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl",
    sha256: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
    size: 18059,
    source: "pypi",
    depends: [],
  },
  "python-docx": {
    name: "python_docx-1.2.0-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl",
    sha256: "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7",
    size: 252987,
    source: "pypi",
    depends: ["lxml", "typing-extensions"],
  },
  narwhals: {
    name: "narwhals-2.27.1-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/d1/89/5d4c86da1130d9059681e5b6cd7645df5c10279a6a079c5c37dcb2cc6f3f/narwhals-2.27.1-py3-none-any.whl",
    sha256: "d057df13f5852b8e157596e82eb5e955fad267425df5e420e0ee9863da483b31",
    size: 483211,
    source: "pypi",
    depends: [],
  },
  plotly: {
    name: "plotly-7.1.0-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/e5/7d/905a3a3d51087515719058c94cfbda2ff0fc14417c20d557ae3e82d8b250/plotly-7.1.0-py3-none-any.whl",
    sha256: "dbb7fa18afce40d0a8e80d1bf162eceb3faa0ce5a77fe741ad09a74cf78f53f3",
    size: 9692368,
    source: "pypi",
    depends: ["narwhals", "packaging"],
  },
  "charset-normalizer": {
    name: "charset_normalizer-3.5.2-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/fc/ad/d07d7862a62ffa6d79d68074d14823243dd235a77c45262acbf6adeb28bf/charset_normalizer-3.5.2-py3-none-any.whl",
    sha256: "b6b751274acb69d77b3323d6b7dbaa3c7fdfc1eb829b7eb61d262f32e1af9685",
    size: 68872,
    source: "pypi",
    depends: [],
  },
  reportlab: {
    name: "reportlab-5.0.1-py3-none-any.whl",
    url: "https://files.pythonhosted.org/packages/db/cb/dacbc268cb68d0428ea2cbd85266195a9ab3e677449589ddae59bd7542ac/reportlab-5.0.1-py3-none-any.whl",
    sha256: "1c36e6bb0e71780c72331eba60da7f602e8d4389a8723825af71342e49d791e8",
    size: 1957258,
    source: "pypi",
    depends: ["pillow", "charset-normalizer"],
  },
};

/** Explicit dependency closure per profile, in load order. `science` includes `analysis`. */
export const PYODIDE_PROFILES: Readonly<Record<PyodideProfile, readonly string[]>> = {
  base: [],
  analysis: [
    "numpy",
    "six",
    "python-dateutil",
    "pytz",
    "pandas",
    "contourpy",
    "cycler",
    "fonttools",
    "kiwisolver",
    "packaging",
    "pillow",
    "pyparsing",
    "matplotlib",
    "markupsafe",
    "jinja2",
    "et-xmlfile",
    "openpyxl",
    "lxml",
    "typing-extensions",
    "python-docx",
    "narwhals",
    "plotly",
    "charset-normalizer",
    "reportlab",
  ],
  science: [
    "numpy",
    "six",
    "python-dateutil",
    "pytz",
    "pandas",
    "contourpy",
    "cycler",
    "fonttools",
    "kiwisolver",
    "packaging",
    "pillow",
    "pyparsing",
    "matplotlib",
    "markupsafe",
    "jinja2",
    "et-xmlfile",
    "openpyxl",
    "lxml",
    "typing-extensions",
    "python-docx",
    "narwhals",
    "plotly",
    "charset-normalizer",
    "reportlab",
    "scipy",
    "patsy",
    "statsmodels",
    "joblib",
    "threadpoolctl",
    "scikit-learn",
  ],
};

/** The shape `setup --wasm` and the backend work with; tests hand in a tiny one of their own. */
export interface PyodideManifest {
  version: string;
  python: string;
  core: readonly PyodideFile[];
  packages: Readonly<Record<string, PyodidePackage>>;
  profiles: Readonly<Record<PyodideProfile, readonly string[]>>;
}

export const PYODIDE_MANIFEST: PyodideManifest = {
  version: PYODIDE_VERSION,
  python: PYTHON_VERSION,
  core: PYODIDE_CORE_FILES,
  packages: PYODIDE_PACKAGES,
  profiles: PYODIDE_PROFILES,
};

export const PYODIDE_PROFILE_ORDER: readonly PyodideProfile[] = ["base", "analysis", "science"];
