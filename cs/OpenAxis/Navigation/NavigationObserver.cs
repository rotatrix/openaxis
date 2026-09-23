using System.Collections.Generic;
using OpenAxis.Client;
using OpenAxis.Geometry;

namespace OpenAxis.Navigation
{
    // Passive optional diagnostics. Called on the host thread, outside locks.
    // Exceptions never alter query completion or camera state.
    public abstract class NavigationObserver
    {
        public virtual void WriteCompleted(object context, string stream, CameraPoseValue desired, CameraPoseValue? actual, bool success) { }
        public virtual void OutputRejected(string kind, long gestureId, string reason) { }
        public virtual void Cancelled(long gestureId, string reason) { }
        public virtual void GestureStarted(long gestureId) { }
        public virtual void GestureFinished(long gestureId, string reason) { }
        public virtual void NavigationStateChanged(NavigationState state) { }
        public virtual void QueryStarted(object context, NavigationQuery query) { }
        public virtual void FactFailed(string name, string error, double durationMs) { }
        public virtual void Fact(string name, object? value, double durationMs) { }
        public virtual void QueryCompleted(NavigationQuery query, Dictionary<string, object> result, double durationMs) { }
        public virtual void QueryFailed(NavigationQuery query, string error, double durationMs) { }
        public virtual void Correction(object context, string kind, long deltaId, PoseDifference? difference) { }
        public virtual void ObjectCorrection(object context, string kind, long deltaId, PoseDifference? difference) { }
    }
}
