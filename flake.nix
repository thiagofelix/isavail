{
  description = "isavail: checks whether .br domains can be registered, using Registro.br's ISAVAIL service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        isavail = pkgs.callPackage ./nix/package.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.isavail;
      });

      overlays.default = final: _prev: {
        isavail = final.callPackage ./nix/package.nix { };
      };

      nixosModules.default = import ./nix/module.nix (
        pkgs: self.packages.${pkgs.stdenv.hostPlatform.system}.default
      );

      # Run on a Linux machine with `nix flake check`. The VM has no internet
      # access, so lookups fail as Registro.br being unreachable; the test
      # checks that the service starts, serves the website and the API, and
      # reports that failure instead of crashing.
      checks = lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        nixos-module = nixpkgs.legacyPackages.${system}.testers.runNixOSTest {
          name = "isavail";
          nodes.machine = {
            imports = [ self.nixosModules.default ];
            services.isavail = {
              enable = true;
              openTelemetry.resourceAttributes."deployment.environment.name" = "test";
            };
          };
          testScript = ''
            machine.wait_for_unit("isavail.service")
            machine.wait_for_open_port(4310)
            machine.succeed("curl --fail http://127.0.0.1:4310/v1/health")
            machine.succeed("curl --fail -H 'accept: text/html' http://127.0.0.1:4310/ | grep -q '<div id=\"root\">'")
            machine.succeed("curl --fail -H 'accept: text/html' http://127.0.0.1:4310/any/page | grep -q '<div id=\"root\">'")
            machine.fail("curl --fail http://127.0.0.1:4310/v1/unknown")
            report = machine.succeed("curl --fail http://127.0.0.1:4310/v1/domains/minhaempresa/availability")
            assert '"NotChecked"' in report, report
            machine.succeed("test -s /var/lib/isavail/isavail.sqlite")
          '';
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
