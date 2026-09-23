using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("OpenAxis.ConformanceTests")]
// Tests inspect serialized state; integrations consume only public SDK contracts.
[assembly: InternalsVisibleTo("RotatrixInventor.Tests")]
