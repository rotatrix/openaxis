using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using OpenAxis.Client;
using OpenAxis.Diagnostics;
using OpenAxis.Geometry;

namespace OpenAxis.ConformanceTests
{
    internal static class NavigationDiagnosticsTests
    {
        internal static int Run(string directory)
        {
            var checks = 0;
            void Check(bool value) { checks++; if (!value) throw new Exception("Navigation diagnostics regression"); }
            var names = new[] { "pick.cursor.selection", "pick.cursor", "pick.viewport_center", "pick.viewport_center.selection" };
            var markerQuery = new NavigationQuery(new Request { Id = 7, Method = "navigation.query", Params = new Dictionary<string, object>
                { ["values"] = names.Take(2).ToArray(), ["first"] = names } }, _ => {}, (_, __) => {});
            var markerDiagnostics = new NavigationDiagnostics(true);
            markerDiagnostics.QueryStarted("view", markerQuery);
            var calls = new List<string>();
            var samples = new object[] { NavigationQuery.Unavailable,
                new Dictionary<string, object> { ["markerPosition"] = new[] { -.5, .25 } },
                new Dictionary<string, object> { ["point"] = new[] { 1.0, 2.0, 3.0 }, ["markerPosition"] = new[] { 0.0, 0.0 } } };
            var markerResult = markerQuery.Evaluate(name => {
                calls.Add(name); var value = samples[Array.IndexOf(names, name)];
                markerDiagnostics.Fact(name, value, 0); return value;
            });
            Check(calls.SequenceEqual(names.Take(3)));
            Check(((Dictionary<string, object>)markerResult["values"]).Count == 0);
            var firstPick = (Dictionary<string, object>)markerResult["first"];
            Check((string)firstPick["name"] == names[2]);
            Check(!((Dictionary<string, object>)firstPick["value"]).ContainsKey("markerPosition"));
            Check(((Dictionary<string, object>)samples[2]).ContainsKey("markerPosition"));
            Check(markerDiagnostics.Presentation().Markers.Count == 2);
            Check(markerDiagnostics.Presentation().Markers[0].X == -.5);
            Check(markerDiagnostics.Presentation().Segments.Count == 3);
            double now = 0;
            var d = new NavigationDiagnostics(true,clock:()=>now);
            using(var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory,"diagnostics.json"))))
            {
                foreach(var step in fixture.RootElement.GetProperty("corrections").EnumerateArray())
                {
                    now = step.GetProperty("time").GetDouble();
                    var kind = step.GetProperty("state").GetString()!;
                    var id = step.GetProperty("id").GetInt64();
                    if (step.GetProperty("stream").GetString() == "camera") d.Correction("view",kind,id,null);
                    else d.ObjectCorrection("view",kind,id,null);
                    Check(d.Presentation().Lines.Count == step.GetProperty("visible").GetInt32());
                }
                now = fixture.RootElement.GetProperty("expire_at").GetDouble();
                Check(d.Presentation().Lines.Count == 0);
            }
            var query = new NavigationQuery(new Request { Id=4,Method="navigation.query",Params=new Dictionary<string,object>
            { ["values"]=new[]{"model.bounds"},["first"]=new[]{"pick.cursor","pick.viewport_center"} } },_=>{},(_,__)=>{});
            d.QueryStarted("view",query);
            var low = new[]{0.0,0.0,0.0};
            var bounds = new Dictionary<string,object>{["min"]=low,["max"]=new[]{2.0,2.0,2.0}};
            d.Fact("model.bounds",bounds,1);
            d.Fact("pick.cursor",new Dictionary<string,object>{["point"]=new[]{1.0,1.0,1.0}},1);
            low[0] = 99;
            d.QueryCompleted(query,new Dictionary<string,object>{["first"]=new Dictionary<string,object>{["name"]="pick.cursor"}},2);
            Check(d.Presentation().Segments.Count == 15);
            Check(d.Presentation().Segments.All(s=>s.Start.X != 99));
            Check(d.Presentation().Lines.Any(l=>l.Text.Contains("skipped")));
            var pose = new CameraPoseValue(default,default,fov:1);
            d.WriteCompleted("view","camera",pose,null,true);
            Check(d.Presentation().Lines.Any(l=>l.Text.Contains("unknown readback")));
            d.WriteCompleted("view","camera",pose,null,false);
            Check(d.Presentation().Lines.Any(l=>l.Text.Contains("failed")));
            d.SetEnabled(false);
            Check(d.Presentation().Lines.Count == 0);
            var logs = new List<string>();
            var logging = new NavigationDiagnostics(log:(level,text)=>logs.Add(level+":"+text));
            logging.Fact("pick.cursor",new Dictionary<string,object>{["point"]=new[]{1.0,2.0,3.0},["bounds"]=bounds},2);
            Check(logs.Single().StartsWith("info:") && logs.Single().Contains("bounds"));
            logs.Clear();
            for(var i=0;i<5;i++) logging.WriteCompleted("view","camera",pose,pose,true);
            Check(logs.Count == 0);
            for(var i=0;i<5;i++) logging.WriteCompleted("view","camera",pose,null,true);
            Check(logs.Count == 1 && logs[0].Contains("unknown readback"));
            logging.WriteCompleted("view","camera",pose,pose,true);
            Check(logs.Last().Contains("recovered"));
            logs.Clear();
            for(var i=0;i<5;i++) logging.Correction("view","waiting",1,null);
            Check(logs.Count == 0);
            logging.DebugLogging = true;
            logging.Correction("view","applied",1,null);
            Check(logs.Last().Contains("acknowledged"));
            Check(logging.Presentation().Lines.Count == 0);
            var key = new object();
            var mapped = new NavigationDiagnostics(true, contextKey: _ => key);
            mapped.QueryStarted(new object(),query);
            mapped.Pick(4,"pick.cursor",10,20);
            mapped.WriteCompleted(new object(),"camera",pose,pose,true);
            Check(ReferenceEquals(mapped.Presentation().Context,key));
            Check(mapped.Presentation().Markers.Count == 1);
            mapped.QueryStarted(new object(),query);
            mapped.Pick(4,"pick.cursor",10,20);
            mapped.Pick(4,"pick.cursor.selection",10,20);
            mapped.Pick(4,"pick.viewport_center",100,100);
            var markers = mapped.Presentation().Markers;
            Check(markers.Count == 2);
            Check(markers[0].Name == "pick.cursor\npick.cursor.selection");
            Check(markers[0].X == 10 && markers[0].Y == 20);
            mapped.Pick(4,"pick.cursor.selection",11,20);
            Check(mapped.Presentation().Markers.Count == 3);
            // A distinct viewport must not inherit stale screen evidence.
            var raw = new NavigationDiagnostics(true);
            raw.QueryStarted("A",query);
            raw.Pick(4,"pick.cursor",10,20);
            raw.WriteCompleted("B","camera",pose,pose,true);
            Check(raw.Presentation().Markers.Count == 0);
            using(var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory,"diagnostic-presentation.json"))))
            {
                var fixture = document.RootElement;
                object Decode(JsonElement e) => e.ValueKind == JsonValueKind.Object
                    ? (object)e.EnumerateObject().ToDictionary(p => p.Name,p => Decode(p.Value))
                    : e.ValueKind == JsonValueKind.Array ? e.EnumerateArray().Select(Decode).ToArray()
                    : e.ValueKind == JsonValueKind.Number ? (object)e.GetDouble() : e.GetString()!;
                Vec3 Vector(JsonElement e) => new Vec3(e[0].GetDouble(),e[1].GetDouble(),e[2].GetDouble());
                var facts = (Dictionary<string,object>)Decode(fixture.GetProperty("facts"));
                var presentation = new NavigationDiagnostics(true);
                var request = new NavigationQuery(new Request { Id=9,Method="navigation.query",Params=new Dictionary<string,object>
                { ["gesture_id"]=7L,["values"]=facts.Keys.ToArray() } },_=>{},(_,__)=>{});
                presentation.QueryStarted("view",request);
                foreach(var fact in facts) presentation.Fact(fact.Key,fact.Value,0);
                presentation.Pick(9,"pick.cursor",20,30,new Vec3(0,0,5),new Vec3(1,1,1));
                presentation.Pick(9,"pick.cursor.selection",20,30);
                presentation.QueryCompleted(request,new Dictionary<string,object>(),0);
                var frame = presentation.Presentation();
                var rows = fixture.GetProperty("rows").EnumerateArray().ToArray();
                Check(frame.Lines.Count == rows.Length);
                for(var i=0;i<rows.Length;i++) {
                    Check(frame.Lines[i].Text == rows[i].GetProperty("text").GetString());
                    Check(frame.Lines[i].Tone == rows[i].GetProperty("tone").GetString());
                }
                var segments = fixture.GetProperty("segments").EnumerateArray().ToArray();
                Check(frame.Segments.Count == segments.Length);
                for(var i=0;i<segments.Length;i++) {
                    Check((frame.Segments[i].Start-Vector(segments[i].GetProperty("start"))).Length()<1e-12);
                    Check((frame.Segments[i].End-Vector(segments[i].GetProperty("end"))).Length()<1e-12);
                    Check(frame.Segments[i].Tone == segments[i].GetProperty("tone").GetString());
                    Check(frame.Segments[i].Width == segments[i].GetProperty("width").GetDouble());
                    Check(frame.Segments[i].Opacity == segments[i].GetProperty("opacity").GetDouble());
                }
                var marker = fixture.GetProperty("markers")[0];
                Check(frame.Markers.Count == 1 && frame.Markers[0].Name == marker.GetProperty("label").GetString());
                Check(frame.Markers[0].X == 20 && frame.Markers[0].Y == 30 && frame.Markers[0].Tone == "cursor");
                foreach(var color in fixture.GetProperty("colors").EnumerateObject())
                    Check(DiagnosticPalette.Color(color.Name).SequenceEqual(color.Value.EnumerateArray().Select(v=>v.GetInt32())));
            }
            using(var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory,"diagnostics.json"))))
            {
                var lifecycleLogs = new List<(string Level,string Text)>();
                var snapshots = new List<DiagnosticPresentation>();
                var lifecycle = new NavigationDiagnostics(true,log:(level,text)=>lifecycleLogs.Add((level,text)));
                lifecycle.Changed = () => snapshots.Add(lifecycle.Presentation());
                foreach(var step in document.RootElement.GetProperty("lifecycle").EnumerateArray())
                {
                    var id = step.GetProperty("id").GetInt64(); var reason = step.GetProperty("reason").GetString()!;
                    var before = snapshots.Count;
                    switch(step.GetProperty("event").GetString()) {
                        case "gesture_started": lifecycle.GestureStarted(id); break;
                        case "output_rejected": lifecycle.OutputRejected("camera.pose",id,reason); break;
                        case "cancelled": lifecycle.Cancelled(id,reason); break;
                        case "gesture_finished": lifecycle.GestureFinished(id,reason); break;
                    }
                    Check(lifecycleLogs.Last().Level == step.GetProperty("level").GetString());
                    Check(lifecycleLogs.Last().Text == step.GetProperty("message").GetString());
                    Check(snapshots.Count == before+1);
                    Check(snapshots.Last().Lines.Last().Text == step.GetProperty("status").GetString());
                }
            }
            now = 10;
            var configured = new NavigationDiagnostics(true,clock:()=>now,historyLimit:2,retention:2.5);
            for(var i=0;i<3;i++) configured.Correction("view","sent",i,null);
            Check(configured.History.Count == 2);
            configured.Correction("view","applied",2,null);
            Check(configured.Presentation().ExpiresAt == 12.5);
            now = 12.5;
            Check(configured.Presentation().ExpiresAt == null && configured.Presentation().Lines.Count == 0);
            return checks;
        }
    }
}
