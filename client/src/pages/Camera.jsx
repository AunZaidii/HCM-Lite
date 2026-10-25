import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Camera, Eye, MapPin, ScanFace } from 'lucide-react';
import * as faceapi from '@vladmandic/face-api';
import { api, errMsg, get } from '../api';
import { Badge, Button, Card, Empty, ErrorState, Loading, PageHeader, cx, fmtDateTime, fmtTime } from '../ui';

// Camera check-in (bonus). Face detection, blink liveness and the face descriptor are computed on this device
// with face-api.js; only the result (face count, liveness flag, 128 numbers) and GPS are sent — never a photo.
// The server decides: one face, GPS accuracy <= 100 m, Haversine distance <= office radius, optional face match.

let modelsPromise;
const loadModels = () => {
  modelsPromise ??= Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
  ]);
  return modelsPromise;
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Eye aspect ratio from 6 eye landmarks: drops sharply when the eye closes.
const ear = (e) => (dist(e[1], e[5]) + dist(e[2], e[4])) / (2 * dist(e[0], e[3]));

export function CameraCheckIn() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings-public'], queryFn: () => get('/settings/public') });
  const face = useQuery({ queryKey: ['face-profile'], queryFn: () => get('/attendance/face') });
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const descriptorRef = useRef(null);
  const blinkRef = useRef({ open: false, closed: false });
  const [phase, setPhase] = useState('consent'); // consent | loading | live
  const [camError, setCamError] = useState('');
  const [faceCount, setFaceCount] = useState(0);
  const [blinked, setBlinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);
  useEffect(() => stopCamera, [stopCamera]);

  // Detection loop: count faces, track blink (EAR drops below 0.21 after being open, then reopens), keep descriptor.
  useEffect(() => {
    if (phase !== 'live') return undefined;
    let stop = false;
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    const tick = async () => {
      if (stop) return;
      const v = videoRef.current;
      if (v && v.readyState >= 2) {
        try {
          const results = await faceapi.detectAllFaces(v, options).withFaceLandmarks().withFaceDescriptors();
          if (stop) return;
          setFaceCount(results.length);
          if (results.length === 1) {
            const lm = results[0].landmarks;
            const value = (ear(lm.getLeftEye()) + ear(lm.getRightEye())) / 2;
            const b = blinkRef.current;
            if (value > 0.26) {
              if (b.closed) setBlinked(true);
              b.open = true;
            } else if (value < 0.21 && b.open) b.closed = true;
            descriptorRef.current = Array.from(results[0].descriptor);
          } else descriptorRef.current = null;
        } catch { /* frame not ready */ }
      }
      setTimeout(tick, 250);
    };
    tick();
    return () => { stop = true; };
  }, [phase]);

  const start = async () => {
    setCamError('');
    setPhase('loading');
    try {
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false }),
        loadModels(),
      ]);
      streamRef.current = stream;
      setPhase('live');
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch (e) {
      setPhase('consent');
      setCamError(e?.name === 'NotAllowedError' ? 'Camera permission was denied.' : `Could not start the camera: ${e?.message || 'unknown error'}`);
    }
  };

  const enroll = async () => {
    if (!descriptorRef.current || faceCount !== 1) return toast.error('Keep exactly one face in the frame');
    try {
      await api.post('/attendance/face/enroll', { descriptor: descriptorRef.current });
      toast.success('Face enrolled — only 128 numbers were saved, no photo');
      qc.invalidateQueries({ queryKey: ['face-profile'] });
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const checkIn = () => {
    if (!navigator.geolocation) return setResult({ ok: false, message: 'Location is not available in this browser.' });
    setBusy(true);
    setResult(null);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { data } = await api.post('/attendance/camera-check-in', {
          lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, faceCount,
          descriptor: descriptorRef.current ?? undefined, livenessPassed: blinked,
        });
        setResult({ ok: true, message: `Checked in at ${fmtTime(data.checkInAt)} (${data.status}) — ${Math.round(data.distanceM)} m from the office${data.faceVerified ? ', face verified' : ''}.` });
        ['today', 'me-dashboard', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        stopCamera();
      } catch (e) {
        setResult({ ok: false, message: errMsg(e) });
      } finally {
        setBusy(false);
      }
    }, (err) => {
      setBusy(false);
      setResult({ ok: false, message: err.code === 1 ? 'Location permission was denied.' : 'Could not get your location. Try again near a window.' });
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  };

  if (settings.isLoading) return <Loading rows={4} />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={settings.refetch} />;
  const s = settings.data;
  const needMatch = s.faceMatchRequired;
  const ready = faceCount === 1 && (!needMatch || (blinked && face.data?.enrolled));

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Camera check-in" subtitle="Face + location check — the server makes the decision" />
      <Card>
        {!s.cameraCheckinEnabled ? (
          <Empty title="Camera check-in is not enabled" icon={Camera}>Admin can enable it and set the office location in Company settings. You can still check in from your dashboard.</Empty>
        ) : (
          <div className="space-y-4">
            <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <b>What we capture:</b> your camera is used only on this device to detect your face{needMatch ? ', check a blink and compare your face to your enrolled profile' : ''}.
              No photo is uploaded. We send your GPS location (must be within {s.officeRadiusM} m of the office, accuracy 100 m or better) and the detection result.
            </p>
            {phase !== 'live' ? (
              <>
                <Button className="w-full" loading={phase === 'loading'} onClick={start}><Camera className="h-4 w-4" /> I agree — open camera</Button>
                {phase === 'loading' && <p className="text-center text-xs text-slate-500">Loading face models…</p>}
                {camError && <p className="text-sm text-red-600">{camError}</p>}
              </>
            ) : (
              <>
                <div className="relative overflow-hidden rounded-xl bg-black">
                  <video ref={videoRef} playsInline muted className="aspect-[3/4] w-full -scale-x-100 object-cover sm:aspect-video" />
                  <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">
                    <Badge status={faceCount === 1 ? 'present' : 'absent'}>
                      {faceCount === 0 ? 'No face detected' : faceCount === 1 ? 'Face detected' : `${faceCount} faces — only you please`}
                    </Badge>
                    <Badge status={blinked ? 'present' : 'pending'}><Eye className="mr-1 h-3 w-3" />{blinked ? 'Blink detected' : 'Please blink once'}</Badge>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-slate-500">
                    {face.data?.enrolled ? `Face enrolled ${fmtDateTime(face.data.enrolledAt)}` : 'Face not enrolled yet'}
                    {needMatch && ' · face match required by Admin'}
                  </span>
                  <Button size="sm" variant="secondary" disabled={faceCount !== 1} onClick={enroll}>
                    <ScanFace className="h-4 w-4" /> {face.data?.enrolled ? 'Re-enroll face' : 'Enroll my face'}
                  </Button>
                </div>
                <Button className="w-full" loading={busy} disabled={!ready || result?.ok} onClick={checkIn}>
                  <MapPin className="h-4 w-4" /> Check in with location
                </Button>
                {needMatch && !face.data?.enrolled && <p className="text-xs text-amber-700">Enroll your face first — Admin requires a face match.</p>}
              </>
            )}
            {result && (
              <div className={cx('rounded-lg p-3 text-sm', result.ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200' : 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200')}>
                {result.message}
                {!result.ok && <div className="mt-1"><Link to="/attendance/corrections" className="font-medium underline">Request a correction from HR</Link></div>}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

export default CameraCheckIn;
