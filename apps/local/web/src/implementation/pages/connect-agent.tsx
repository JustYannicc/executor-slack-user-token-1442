import { QueryView } from "@executor-js/ui/dashboard/context";
import { McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import { ScopedConnectionsPage } from "@executor-js/ui/dashboard/scoped-connections";
import { ConnectionToolPicker } from "@executor-js/ui/dashboard/connection-tool-picker";
import { overviewAtom, toolListAtom } from "../../contracts/api.ts";
import { mcpInstallationAtom } from "../../contracts/mcp.ts";
import {
  mcpConnectionsAtom,
  revokeMcpConnectionAtom,
  saveMcpConnectionAtom,
} from "../../contracts/mcp-connections.ts";
import { Failure, LoadingRows } from "../components/common.tsx";

/** This instance's full-access URL and the operator's scoped connections. */
export function ConnectAgentPage() {
  return (
    <ScopedConnectionsPage
      query={overviewAtom}
      connections={mcpConnectionsAtom}
      save={saveMcpConnectionAtom}
      revoke={revokeMcpConnectionAtom}
      Failure={Failure}
      renderTools={({ app, names, onChange }) => (
        <ConnectionToolPicker
          query={toolListAtom({
            app: app.id,
            version: app.activeVersion,
          })}
          Failure={Failure}
          names={names}
          onChange={onChange}
        />
      )}
      installation={
        <QueryView
          query={mcpInstallationAtom}
          Failure={Failure}
          pending={<LoadingRows count={3} />}
        >
          {(data) => (
            <McpInstallInstructions endpoint={data.endpoint}>
              Executor keeps running in the background until you stop it. After you restart your
              computer, run <code>executor</code> or <code>executor service start</code> again.
            </McpInstallInstructions>
          )}
        </QueryView>
      }
    />
  );
}
