import { NavigationSession, compareObjectPoses, type NavigationAdapter, type NavigationObjectAdapter, type ObjectWriteResult } from "../dist/index.js";
import { createNavigationObserver } from "../dist/index.js";

export const observer = createNavigationObserver({
  gesture_started: values => { const id: number = values.gestureId; void id; },
}, event => { const name: string = event.event; void name; });

const camera: NavigationAdapter<string> = {
  captureContext: () => "viewport",
  isCurrent: context => context === "viewport",
  beginQuery: () => ({ resolve: () => undefined }),
  applyPose(context, pose) {
    const kind: "camera.pose" = pose.type;
    return { success: context.length > 0 && kind === "camera.pose", realizedPose: pose };
  },
};
const object: NavigationObjectAdapter<number> = {
  captureContext: () => 1,
  isCurrent: context => context === 1,
  beginQuery: () => ({ resolve: () => undefined, initialObservation: () => ({ t: [0,0,0], r: [0,0,0] }) }),
  applyPose(context, pose): ObjectWriteResult {
    const kind: "object.pose" = pose.type;
    // @ts-expect-error Object poses do not have a camera field of view.
    pose.fov;
    return { success: context > 0 && kind === "object.pose", realizedPose: pose };
  },
};
export function attach(client: ConstructorParameters<typeof NavigationSession>[0]) {
  const session = new NavigationSession(client, camera, { objectAdapter: object, objectComparison: compareObjectPoses });
  const active: boolean = session.isActive;
  return { session, active };
}
