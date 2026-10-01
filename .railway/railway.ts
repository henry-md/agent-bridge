import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const agentBridgeVolume = volume("agent-bridge-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 5000 });
  const agentBridge = service("agent-bridge", {
    source: github("henry-md/agent-bridge", { branch: "main", checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    deploy: { sleepApplication: false, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    replicas: { "us-east4-eqdc4a": 1 },
    volumeMounts: { "/data": agentBridgeVolume },
    env: { ADMIN_TOKEN: preserve(), DATA_DIR: preserve(), RAILWAY_RUN_UID: preserve() },
  });

  return project("agent-bridge", {
    resources: [agentBridge, agentBridgeVolume],
  });
});
