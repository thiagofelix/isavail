# NixOS module for isavail. The flake exposes it as `nixosModules.default`,
# with the flake's own package as the default `services.isavail.package`.
defaultPackage:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.isavail;
  otel = cfg.openTelemetry;

  # OTEL_RESOURCE_ATTRIBUTES is a comma-separated list of key=value pairs
  # whose keys and values are percent-encoded.
  encodeResourceAttributes =
    attributes:
    lib.concatStringsSep "," (
      lib.mapAttrsToList (
        key: value: "${lib.strings.escapeURL key}=${lib.strings.escapeURL value}"
      ) attributes
    );
in
{
  options.services.isavail = {
    enable = lib.mkEnableOption "isavail, a website and HTTP API that checks whether .br domains can be registered";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage pkgs;
      defaultText = lib.literalExpression "isavail.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The isavail package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = ''
        Address to listen on. The default serves only this machine, for use
        behind a reverse proxy; use `0.0.0.0` or `::` to serve the network.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4310;
      description = "TCP port for the website and the `/v1` API.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open {option}`services.isavail.port` in the firewall.";
    };

    openTelemetry = {
      endpoint = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "http://otel-collector.home.arpa:4318";
        description = ''
          Base URL of an OpenTelemetry collector's OTLP/HTTP receiver
          (`OTEL_EXPORTER_OTLP_ENDPOINT`). Traces, logs, and metrics are sent
          to `/v1/traces`, `/v1/logs`, and `/v1/metrics` under it, as protobuf.
          `null` exports nothing; logs still reach the journal.
        '';
      };

      serviceName = lib.mkOption {
        type = lib.types.str;
        default = "isavail";
        description = "`service.name` of the exported telemetry (`OTEL_SERVICE_NAME`).";
      };

      resourceAttributes = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        example = {
          "deployment.environment.name" = "homelab";
          "host.name" = "nas";
        };
        description = "Extra resource attributes on all telemetry (`OTEL_RESOURCE_ATTRIBUTES`).";
      };
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        OTEL_METRICS_EXPORTER = "none";
      };
      description = ''
        Extra environment variables, applied last. Any standard `OTEL_*`
        variable works here. Put secrets such as
        `OTEL_EXPORTER_OTLP_HEADERS` in {option}`services.isavail.environmentFile`
        instead, which stays out of the Nix store.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/isavail.env";
      description = "File of `NAME=value` lines loaded into the service environment, for secrets.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.isavail = {
      description = "isavail .br domain availability";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = {
        ISAVAIL_HOST = cfg.host;
        ISAVAIL_PORT = toString cfg.port;
        ISAVAIL_DATABASE = "/var/lib/isavail/isavail.sqlite";
        OTEL_SERVICE_NAME = otel.serviceName;
      }
      // lib.optionalAttrs (otel.endpoint != null) {
        OTEL_EXPORTER_OTLP_ENDPOINT = otel.endpoint;
      }
      // lib.optionalAttrs (otel.resourceAttributes != { }) {
        OTEL_RESOURCE_ATTRIBUTES = encodeResourceAttributes otel.resourceAttributes;
      }
      // cfg.environment;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 5;

        DynamicUser = true;
        StateDirectory = "isavail";
        WorkingDirectory = "/var/lib/isavail";

        CapabilityBoundingSet = "";
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProcSubset = "pid";
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RemoveIPC = true;
        # UDP to Registro.br and TCP for HTTP both need IP sockets.
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        UMask = "0077";
        # MemoryDenyWriteExecute stays off: V8's JIT needs writable, executable memory.
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
