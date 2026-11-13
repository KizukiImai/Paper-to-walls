// PAPER / SPACE v1.1 — optional Unity-side example, not a full Unity project.
// Place in Assets/Scripts, attach to an empty GameObject, then enter Play Mode.
// Run start-receiver.bat on THIS PC first. This component polls its localhost API.
using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

namespace PaperSpace
{
    public sealed class PaperSpaceLayoutReceiver : MonoBehaviour
    {
        [Header("Receiver on this Unity PC")]
        public string serverBaseUrl = "http://127.0.0.1:3001";
        [Min(0.2f)] public float pollingSeconds = 0.5f;
        [Range(1, 30)] public int timeoutSeconds = 5;
        [Tooltip("Assign a material compatible with your render pipeline (Built-in / URP / HDRP).")]
        public Material wallMaterial;
        [Header("Runtime status")]
        public string connectionStatus = "Not started";
        public long appliedRevision;
        public int wallCount;

        [Serializable] public class Layout
        {
            public int schemaVersion;
            public string layoutId;
            public long revision;
            public string units;
            public float wallHeight;
            public float wallThickness;
            public Wall[] walls;
        }
        [Serializable] public class Wall
        {
            public string id;
            public float ax, ay, bx, by;
        }

        private GameObject generated;
        private UnityWebRequest activeRequest;
        private string lastJson;

        private void OnEnable() { StartCoroutine(Poll()); }
        private void OnDisable()
        {
            if (activeRequest != null) activeRequest.Abort();
            StopAllCoroutines();
            activeRequest = null;
            connectionStatus = "Stopped";
        }
        private void OnDestroy() { if (generated != null) Destroy(generated); }

        private IEnumerator Poll()
        {
            while (true)
            {
                Uri baseUri;
                if (!Uri.TryCreate((serverBaseUrl ?? "").TrimEnd('/') + "/api/layouts/latest", UriKind.Absolute, out baseUri)
                    || (baseUri.Scheme != "http" && baseUri.Scheme != "https"))
                {
                    connectionStatus = "Invalid serverBaseUrl";
                    yield return new WaitForSecondsRealtime(1f);
                    continue;
                }
                using (var request = UnityWebRequest.Get(baseUri.AbsoluteUri))
                {
                    activeRequest = request;
                    request.timeout = Mathf.Clamp(timeoutSeconds, 1, 30);
                    UnityWebRequestAsyncOperation operation = null;
                    try { operation = request.SendWebRequest(); }
                    catch (Exception error)
                    {
                        connectionStatus = "Request could not start: " + error.Message
                            + " / Check Player Settings > Allow downloads over HTTP for this trusted-LAN setup.";
                    }
                    if (operation != null)
                    {
                    yield return operation;
                    if (request.responseCode == 204)
                        connectionStatus = "Receiver connected / waiting for first layout";
                    else if (request.result != UnityWebRequest.Result.Success)
                        connectionStatus = "Receiver error: " + request.error;
                    else
                    {
                        string json = request.downloadHandler.text;
                        // Compare payload, not just a revision number from a different server/reset.
                        if (json != lastJson)
                        {
                            GameObject next = null;
                            try
                            {
                                if (json.Length > 1024 * 1024) throw new Exception("Response exceeds 1 MB");
                                var layout = JsonUtility.FromJson<Layout>(json);
                                Validate(layout);
                                next = Build(layout);
                                if (generated != null) { generated.SetActive(false); Destroy(generated); }
                                generated = next;
                                generated.SetActive(true);
                                lastJson = json;
                                appliedRevision = layout.revision;
                                wallCount = layout.walls.Length;
                                connectionStatus = "Applied r" + layout.revision + " / " + wallCount + " walls";
                            }
                            catch (Exception error)
                            {
                                if (next != null) Destroy(next);
                                connectionStatus = "Rejected; previous walls kept: " + error.Message;
                                Debug.LogWarning(connectionStatus, this);
                            }
                        }
                        else connectionStatus = "Connected / applied r" + appliedRevision;
                    }
                    }
                    activeRequest = null;
                }
                yield return new WaitForSecondsRealtime(Mathf.Max(0.2f, pollingSeconds));
            }
        }

        private static bool Finite(float number) { return !float.IsNaN(number) && !float.IsInfinity(number); }
        private static void Validate(Layout layout)
        {
            if (layout == null || layout.schemaVersion != 1 || layout.units != "m" || layout.revision < 1)
                throw new Exception("Unsupported or incomplete layout");
            if (string.IsNullOrEmpty(layout.layoutId) || layout.layoutId.Length > 100)
                throw new Exception("Invalid layoutId");
            if (!Finite(layout.wallHeight) || layout.wallHeight < 0.1f || layout.wallHeight > 20f
                || !Finite(layout.wallThickness) || layout.wallThickness < 0.01f || layout.wallThickness > 2f)
                throw new Exception("Invalid wall dimensions");
            if (layout.walls == null || layout.walls.Length > 1000) throw new Exception("Invalid walls array");
            var ids = new HashSet<string>();
            foreach (var wall in layout.walls)
            {
                if (wall == null || string.IsNullOrEmpty(wall.id) || wall.id.Length > 100 || !ids.Add(wall.id))
                    throw new Exception("Missing or duplicate wall id");
                foreach (float coordinate in new[] { wall.ax, wall.ay, wall.bx, wall.by })
                    if (!Finite(coordinate) || Mathf.Abs(coordinate) > 10000f) throw new Exception("Invalid coordinate");
                if (Vector2.Distance(new Vector2(wall.ax, wall.ay), new Vector2(wall.bx, wall.by)) < 0.001f)
                    throw new Exception("Zero-length wall");
            }
        }
        private GameObject Build(Layout layout)
        {
            var next = new GameObject("PaperSpaceWalls_r" + layout.revision);
            next.SetActive(false); // Stage the new set before removing the old one.
            try
            {
                foreach (var wall in layout.walls)
                {
                    Vector3 start = new Vector3(wall.ax, 0f, wall.ay);
                    Vector3 end = new Vector3(wall.bx, 0f, wall.by);
                    Vector3 delta = end - start;
                    var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    cube.name = wall.id;
                    cube.transform.SetParent(next.transform, false);
                    cube.transform.localPosition = (start + end) * 0.5f + Vector3.up * (layout.wallHeight * 0.5f);
                    cube.transform.localRotation = Quaternion.FromToRotation(Vector3.right, delta.normalized);
                    cube.transform.localScale = new Vector3(delta.magnitude, layout.wallHeight, layout.wallThickness);
                    if (wallMaterial != null) cube.GetComponent<Renderer>().sharedMaterial = wallMaterial;
                }
                return next;
            }
            catch { Destroy(next); throw; }
        }
    }
}
