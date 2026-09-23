using System.Collections.Generic;

namespace OpenAxis.Client
{
    /// <summary>
    /// Receives OpenAxis 1.0 messages. Callbacks run serially on the client's receive task;
    /// implementations should return promptly and marshal application work to the required thread.
    /// </summary>
    public interface IOpenAxisListener
    {
        void OnFrame(Frame frame);
        void OnButtons(int value);
        void OnMotionStart(long gestureId);
        void OnMotionEnd(long gestureId);
        void OnNavigationState(NavigationState state);
        void OnCameraPose(CameraPose pose);
        void OnCameraPivot(CameraPivot pivot);
        void OnObjectPose(ObjectPose pose);
        void OnObjectPivot(ObjectPivot pivot);
        void OnAxes(string[] axes);
        /// <summary>
        /// Returns true after accepting the query. The implementation must then call
        /// <see cref="NavigationQuery.Complete"/> or <see cref="NavigationQuery.Fail"/> exactly once.
        /// </summary>
        bool OnNavigationQuery(NavigationQuery query);
        /// <summary>Returns true after accepting responsibility for the correlated response.</summary>
        bool OnRequest(Request request);
        void OnResponse(Response response);
        void OnExtension(string messageType, Dictionary<string, object> message);
        void OnStateChange(ConnectionState state);
        void OnError(string code, string message);
    }

    public class OpenAxisListenerBase : IOpenAxisListener
    {
        public virtual void OnFrame(Frame frame) { }
        public virtual void OnButtons(int value) { }
        public virtual void OnMotionStart(long gestureId) { }
        public virtual void OnMotionEnd(long gestureId) { }
        public virtual void OnNavigationState(NavigationState state) { }
        public virtual void OnCameraPose(CameraPose pose) { }
        public virtual void OnCameraPivot(CameraPivot pivot) { }
        public virtual void OnObjectPose(ObjectPose pose) { }
        public virtual void OnObjectPivot(ObjectPivot pivot) { }
        public virtual void OnAxes(string[] axes) { }
        public virtual bool OnNavigationQuery(NavigationQuery query) => false;
        public virtual bool OnRequest(Request request) => false;
        public virtual void OnResponse(Response response) { }
        public virtual void OnExtension(string messageType, Dictionary<string, object> message) { }
        public virtual void OnStateChange(ConnectionState state) { }
        public virtual void OnError(string code, string message) { }
    }
}
