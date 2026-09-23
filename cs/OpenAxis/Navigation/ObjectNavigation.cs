using OpenAxis.Geometry;
using OpenAxis.Client;

namespace OpenAxis.Navigation
{
    public readonly struct ObjectPoseValue
    {
        public Vec3 Position { get; }
        public Vec3 RotationVector { get; }
        public ObjectPoseValue(Vec3 position, Vec3 rotationVector)
        {
            var validated = new CameraPoseValue(position, rotationVector);
            Position = validated.Position; RotationVector = validated.RotationVector;
        }
        internal CameraPoseValue ToState() => new CameraPoseValue(Position, RotationVector);
        internal static ObjectPoseValue FromState(CameraPoseValue pose) => new ObjectPoseValue(pose.Position, pose.RotationVector);
    }
    public readonly struct ObjectWriteResult
    {
        public readonly bool Success;
        public readonly ObjectPoseValue? Realized;
        public ObjectWriteResult(bool success, ObjectPoseValue? realized = null)
        { Success = success; Realized = realized; }
    }
    public interface INavigationObjectCapture
    {
        object? Resolve(string name);
        ObjectPoseValue? InitialObjectObservation();
    }
    /// <summary>Owns a stable native object target, not the lifetime of a adapter transaction.</summary>
    public interface INavigationObjectAdapter
    {
        object? CaptureContext();
        bool IsCurrent(object context);
        INavigationObjectCapture BeginQuery(object context);
        ObjectWriteResult ApplyObject(object context, ObjectPoseValue desired, NavigationState? state, Vec3? pivot);
        void ShowPivot(object context, Vec3? point);
    }
}
