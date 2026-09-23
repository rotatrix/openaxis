namespace OpenAxis.Diagnostics
{
    public static class DiagnosticPalette
    {
        public static int[] Color(string tone)
        {
            switch (tone)
            {
                case "missing": return new[]{255,130,130};
                case "skipped": return new[]{165,165,165};
                case "pass": return new[]{80,255,110};
                case "selection": return new[]{255,150,40};
                case "object": return new[]{255,70,220};
                case "sketch": return new[]{190,120,255};
                case "model": return new[]{40,210,255};
                case "target": return new[]{255,70,220};
                case "cursor": return new[]{255,235,40};
                case "center": return new[]{100,170,255};
                case "ray": return new[]{175,175,175};
                case "correction": return new[]{255,210,40};
                case "axis_x": return new[]{255,60,60};
                case "axis_y": return new[]{60,255,60};
                case "axis_z": return new[]{60,130,255};
                default: return new[]{245,245,245};
            }
        }
    }
}
