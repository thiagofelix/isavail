{
  lib,
  stdenv,
  fetchPnpmDeps,
  makeWrapper,
  nodejs-slim_24,
  nodejs_24,
  pnpm,
  pnpmConfigHook,
}:
let
  # Only what building the app needs; the vendored `repos/` sources and the
  # docs stay out of the build, so editing them never rebuilds the package.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.base.json
      ../tsconfig.json
      ../vite.config.ts
      ../apps/isavail
      ../tools
    ];
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "isavail";
  version = (lib.importJSON ../apps/isavail/package.json).version;
  inherit src;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 4;
    # pnpm on macOS leaves an empty v11/links directory in the store that it
    # never creates on Linux; every file is otherwise identical. Dropping empty
    # directories before the store is archived makes `hash` the same on every
    # platform.
    postInstall = ''
      find "$storePath" -type d -empty -delete
    '';
    # Update after any pnpm-lock.yaml change: set to "" (or lib.fakeHash),
    # run `nix build`, and copy the hash Nix reports.
    hash = "sha256-/YPlZEz7e7HlBhirWI5hv0xNhxdQI1BiNqdRZ8/hXOc=";
  };

  nativeBuildInputs = [
    makeWrapper
    nodejs_24
    pnpm
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild

    pushd apps/isavail
    node node_modules/vite-plus/bin/vp build
    node node_modules/vite-plus/bin/vp build --config vite.server.config.ts
    popd

    runHook postBuild
  '';

  # The server bundle carries every JavaScript dependency, so the package is
  # the bundle, the website, and the Node runtime; no node_modules ship.
  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/isavail
    cp -r apps/isavail/dist/server apps/isavail/dist/client $out/lib/isavail/

    makeWrapper ${lib.getExe nodejs-slim_24} $out/bin/isavail \
      --add-flags --enable-source-maps \
      --add-flags $out/lib/isavail/server/main.js \
      --set-default NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "Checks whether .br domains can be registered, using Registro.br's ISAVAIL service";
    mainProgram = "isavail";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
