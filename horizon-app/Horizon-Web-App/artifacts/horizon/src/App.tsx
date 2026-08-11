import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import { type GeoPoint } from '@/lib/geodesy';
import { getArPosition, type ArPosition } from '@/lib/ar-position';
import {
  buildLandIndex,
  findFirstLargeLand,
  type GeoJsonFeatureCollection,
  type LandArea,
  type LandCategory,
} from '@/lib/land-detection';
import { findVisibleTouristPoints, type VisibleTouristPoint } from '@/lib/tourist-points';

type AppState = 'onboarding' | 'requesting' | 'permission' | 'experience';
type PermissionState = 'camera' | 'unsupported' | 'denied';

type OrientationPermissionEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

type CompassOrientationEvent = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
};

type LocationStatus = 'waiting' | 'active' | 'unavailable';

type HorizonLocation = {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  altitude: number | null;
  status: LocationStatus;
};

const DEMO_LOCATION = {
  latitude: -22.9675,
  longitude: -43.1798,
};

type ResultState = 'waiting' | 'calculating' | 'poi' | 'land' | 'ocean' | 'no-location' | 'unavailable';

type HorizonResult = {
  state: ResultState;
  name?: string;
  distanceKm?: number;
  bearing?: number;
  position?: ArPosition;
  category?: LandCategory;
  detail?: string;
};

function getCardinal(degrees: number) {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(degrees / 45) % 8];
}

function normalizeHeading(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function formatCoordinate(value: number) {
  return `${value >= 0 ? '' : '−'}${Math.abs(value).toFixed(5)}`;
}

function formatDistance(distanceKm: number) {
  if (distanceKm < 1) return `${Math.round(distanceKm * 1000)} m`;
  return `${distanceKm >= 100 ? Math.round(distanceKm).toLocaleString('pt-BR') : distanceKm.toFixed(1).replace('.', ',')} km`;
}

function shortestHeadingDelta(from: number, to: number) {
  return ((to - from + 540) % 360) - 180;
}

function Home() {
  const [appState, setAppState] = useState<AppState>('onboarding');
  const [permissionState, setPermissionState] = useState<PermissionState>('camera');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [heading, setHeading] = useState(100);
  const [sensorStatus, setSensorStatus] = useState<'waiting' | 'active'>('waiting');
  const [pitchDegrees, setPitchDegrees] = useState<number | null>(null);
  const [location, setLocation] = useState<HorizonLocation>({
    latitude: null,
    longitude: null,
    accuracy: null,
    altitude: null,
    status: 'waiting',
  });
  const [landIndex, setLandIndex] = useState<LandArea[] | null>(null);
  const [result, setResult] = useState<HorizonResult>({ state: 'waiting' });
  const [visiblePoints, setVisiblePoints] = useState<VisibleTouristPoint[]>([]);
  const [sheet, setSheet] = useState<'about' | 'signal' | null>(null);
  const [captureNotice, setCaptureNotice] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureTimerRef = useRef<number | undefined>(undefined);
  const orientationCleanupRef = useRef<(() => void) | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  const headingFrameRef = useRef<number | undefined>(undefined);
  const calculationTimerRef = useRef<number | undefined>(undefined);
  const targetHeadingRef = useRef(100);
  const smoothedHeadingRef = useRef(100);

  const stopStream = useCallback(() => {
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
  }, [stream]);

  const stopLocationWatch = useCallback(() => {
    if (locationWatchRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
    }
  }, []);

  const startLocationWatch = useCallback(() => {
    stopLocationWatch();
    setLocation({
      latitude: null,
      longitude: null,
      accuracy: null,
      altitude: null,
      status: 'waiting',
    });

    if (!navigator.geolocation) {
      setLocation((current) => ({ ...current, status: 'unavailable' }));
      return;
    }

    try {
      locationWatchRef.current = navigator.geolocation.watchPosition(
        (position) => {
          setLocation({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
            altitude: Number.isFinite(position.coords.altitude ?? NaN) ? position.coords.altitude : null,
            status: 'active',
          });
        },
        () => {
          setLocation((current) => ({ ...current, status: 'unavailable' }));
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 5000,
        },
      );
    } catch {
      setLocation((current) => ({ ...current, status: 'unavailable' }));
    }
  }, [stopLocationWatch]);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [stream, isDemo]);

  useEffect(() => {
    const activeStream = stream;
    return () => {
      activeStream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  useEffect(() => {
    return () => {
      orientationCleanupRef.current?.();
      stopLocationWatch();
      if (headingFrameRef.current) window.cancelAnimationFrame(headingFrameRef.current);
      if (calculationTimerRef.current) window.clearTimeout(calculationTimerRef.current);
      if (captureTimerRef.current) window.clearTimeout(captureTimerRef.current);
    };
  }, [stopLocationWatch]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${import.meta.env.BASE_URL}data/world-countries.geojson`)
      .then((response) => {
        if (!response.ok) throw new Error(`GeoJSON request failed: ${response.status}`);
        return response.json() as Promise<GeoJsonFeatureCollection>;
      })
      .then((collection) => {
        if (!cancelled) setLandIndex(buildLandIndex(collection));
      })
      .catch(() => {
        if (!cancelled) setLandIndex([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const animateHeading = useCallback((nextHeading: number) => {
    targetHeadingRef.current = normalizeHeading(nextHeading);
    if (headingFrameRef.current) return;

    const tick = () => {
      const current = smoothedHeadingRef.current;
      const target = targetHeadingRef.current;
      const delta = shortestHeadingDelta(current, target);
      const next = Math.abs(delta) < 0.08
        ? target
        : normalizeHeading(current + delta * 0.16);

      smoothedHeadingRef.current = next;
      setHeading(Math.round(next) % 360);

      if (Math.abs(shortestHeadingDelta(next, target)) < 0.08) {
        smoothedHeadingRef.current = target;
        setHeading(Math.round(target) % 360);
        headingFrameRef.current = undefined;
        return;
      }

      headingFrameRef.current = window.requestAnimationFrame(tick);
    };

    headingFrameRef.current = window.requestAnimationFrame(tick);
  }, []);

  const listenForOrientation = useCallback(() => {
    const onOrientation = (event: DeviceOrientationEvent) => {
      const compassEvent = event as CompassOrientationEvent;
      const compassHeading = compassEvent.webkitCompassHeading;
      let rawHeading: number | null = null;

      if (typeof compassHeading === 'number' && Number.isFinite(compassHeading)) {
        rawHeading = compassHeading;
      } else if (typeof event.alpha === 'number' && Number.isFinite(event.alpha)) {
        const screenAngle = typeof window.screen.orientation?.angle === 'number'
          ? window.screen.orientation.angle
          : typeof window.orientation === 'number' ? window.orientation : 0;
        rawHeading = 360 - event.alpha + screenAngle;
      }

      if (typeof event.beta === 'number' && Number.isFinite(event.beta)) {
        setPitchDegrees(Math.max(-90, Math.min(90, event.beta - 90)));
      }

      if (rawHeading !== null) {
        setSensorStatus('active');
        animateHeading(rawHeading);
      } else if (event.beta !== null || event.gamma !== null) {
        setSensorStatus('active');
      }
    };

    window.addEventListener('deviceorientation', onOrientation, true);
    return () => window.removeEventListener('deviceorientation', onOrientation, true);
  }, [animateHeading]);

  const requestOrientationAccess = useCallback(async () => {
    orientationCleanupRef.current?.();
    orientationCleanupRef.current = null;
    setSensorStatus('waiting');

    const orientationEvent = window.DeviceOrientationEvent as OrientationPermissionEvent;
    if (orientationEvent?.requestPermission) {
      try {
        const result = await orientationEvent.requestPermission();
        return result === 'granted';
      } catch {
        // Keep the demonstrative E 100° value when access is unavailable.
      }
      return false;
    }

    return 'DeviceOrientationEvent' in window;
  }, []);

  const calculationOrigin = useMemo<GeoPoint | null>(() => {
    if (isDemo) return DEMO_LOCATION;
    if (
      location.status !== 'active' ||
      location.latitude === null ||
      location.longitude === null
    ) {
      return null;
    }
    return {
      latitude: location.latitude,
      longitude: location.longitude,
    };
  }, [isDemo, location.latitude, location.longitude, location.status]);

  const calculateScene = useCallback(() => {
    if (!calculationOrigin) {
      setVisiblePoints([]);
      setResult({ state: 'no-location', detail: 'A localização é necessária' });
      return;
    }

    const calculationHeading = isDemo ? 100 : heading;

    // Nearby landmarks can be resolved without waiting for the world dataset.
    // This is important for places such as Forte de Copacabana.
    const points = findVisibleTouristPoints(
      calculationOrigin,
      calculationHeading,
      pitchDegrees,
    ).filter((point) => point.distanceKm <= 80);
    setVisiblePoints(points);

    const alignedPoint = points[0];
    if (alignedPoint && alignedPoint.alignment <= 18) {
      setResult({
        state: 'poi',
        name: alignedPoint.name,
        distanceKm: alignedPoint.distanceKm,
        bearing: alignedPoint.bearing,
        position: alignedPoint.position,
        detail: alignedPoint.city,
      });
      return;
    }

    if (landIndex === null) {
      setResult({ state: 'calculating', detail: 'Carregando dados geográficos' });
      return;
    }

    if (landIndex.length === 0) {
      setResult({ state: 'unavailable', detail: 'Dados geográficos indisponíveis' });
      return;
    }

    const firstLand = findFirstLargeLand(
      calculationOrigin,
      calculationHeading,
      landIndex,
    );
    if (firstLand) {
      setResult({
        state: 'land',
        name: firstLand.area.name.toUpperCase(),
        distanceKm: firstLand.distanceKm,
        category: firstLand.area.category,
        detail: firstLand.area.continent ?? undefined,
        position: getArPosition(calculationHeading, calculationHeading, pitchDegrees),
      });
      return;
    }

    setResult({
      state: 'ocean',
      name: 'OCEANO ABERTO',
      detail: 'Nenhuma terra encontrada nessa direção',
    });
  }, [calculationOrigin, heading, isDemo, landIndex, pitchDegrees]);

  useEffect(() => {
    if (appState !== 'experience') return;
    setResult((current) => current.state === 'waiting' ? { state: 'calculating' } : current);
    if (calculationTimerRef.current) window.clearTimeout(calculationTimerRef.current);
    calculationTimerRef.current = window.setTimeout(calculateScene, 220);
    return () => {
      if (calculationTimerRef.current) window.clearTimeout(calculationTimerRef.current);
    };
  }, [appState, calculateScene]);

  const diagnosticTarget = visiblePoints[0];
  const diagnosticDelta = diagnosticTarget ? Math.abs(shortestHeadingDelta(heading, diagnosticTarget.bearing)) : undefined;

  const beginExperience = useCallback(async () => {
    setAppState('requesting');
    const orientationGranted = await requestOrientationAccess();
    startLocationWatch();

    let cameraStream: MediaStream | null = null;
    let cameraFailed: PermissionState | null = null;

    if (!navigator.mediaDevices?.getUserMedia) {
      cameraFailed = 'unsupported';
    } else {
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1440 }, height: { ideal: 1920 } },
        });
      } catch {
        cameraFailed = 'denied';
      }
    }

    if (cameraStream) {
      setStream(cameraStream);
      setIsDemo(false);
      if (orientationGranted) {
        orientationCleanupRef.current = listenForOrientation();
      }
      setAppState('experience');
    } else {
      stopLocationWatch();
      setPermissionState(cameraFailed ?? 'denied');
      setAppState('permission');
    }
  }, [listenForOrientation, requestOrientationAccess, startLocationWatch, stopLocationWatch]);

  const enterDemo = useCallback(() => {
    stopStream();
    stopLocationWatch();
    setLocation({
      latitude: DEMO_LOCATION.latitude,
      longitude: DEMO_LOCATION.longitude,
      accuracy: null,
      altitude: null,
      status: 'unavailable',
    });
    // Demo fixes the location at Copacabana Palace but keeps the live heading
    // when the sensor is already active, making it possible to point at
    // landmarks and validate the geospatial engine without GPS drift.
    if (sensorStatus !== 'active') {
      targetHeadingRef.current = 100;
      smoothedHeadingRef.current = 100;
      setHeading(100);
    }
    setPitchDegrees(null);
    setIsDemo(true);
    setAppState('experience');
  }, [stopLocationWatch, stopStream]);

  const toggleDemo = useCallback(() => {
    if (isDemo) return;
    enterDemo();
  }, [enterDemo, isDemo]);

  const takeCapture = useCallback(() => {
    if (isCapturing) return;
    setIsCapturing(true);
    if (videoRef.current && stream && !isDemo) {
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 720;
      canvas.height = video.videoHeight || 1280;
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const link = document.createElement('a');
        link.download = `horizon-${Date.now()}.jpg`;
        link.href = canvas.toDataURL('image/jpeg', 0.88);
        link.click();
      }
    }
    setCaptureNotice('CAPTURA GUARDADA');
    captureTimerRef.current = window.setTimeout(() => {
      setCaptureNotice('');
      setIsCapturing(false);
    }, 1800);
  }, [isCapturing, isDemo, stream]);

  if (appState === 'onboarding') {
    return (
      <main className="horizon-root horizon-grain flex min-h-[100dvh] flex-col justify-between bg-[#06090a] px-7 py-8 text-[#eeeade]">
        <div className="safe-top onboarding-enter flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-[#8aa4a1]">
          <span>Instrumento 01</span>
          <span className="font-mono text-[#d8ba77]">R / 2024</span>
        </div>
        <section className="onboarding-enter delay-1 -mt-10">
          <div className="relative mb-10 h-16 w-16">
            <div className="absolute inset-0 rounded-full border border-[#d8ba77]/60" />
            <div className="absolute inset-[9px] rounded-full border border-[#a7d4c9]/25" />
            <div className="absolute left-1/2 top-1/2 h-px w-24 -translate-x-1/2 bg-[#d8ba77]/45" />
            <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#d8ba77]" />
          </div>
          <p className="mb-4 text-[11px] uppercase tracking-[0.4em] text-[#a7d4c9]">HORIZON</p>
          <h1 className="max-w-[310px] font-serif text-[clamp(3.1rem,13vw,5.3rem)] leading-[0.9] tracking-[-0.045em]">
            O mundo<br /><em className="text-[#d8ba77]">continua.</em>
          </h1>
          <p className="mt-9 max-w-[275px] text-[15px] leading-6 text-[#9aaba8]">
            Descubra o que existe além do seu horizonte.
          </p>
        </section>
        <div className="safe-bottom onboarding-enter delay-2">
          <button
            type="button"
            data-testid="button-start"
            onClick={() => void beginExperience()}
            className="group flex w-full items-center justify-between border-b border-[#d8ba77]/55 pb-4 text-left text-[12px] font-semibold uppercase tracking-[0.26em] text-[#eeeade] transition-colors hover:border-[#d8ba77] active:text-[#d8ba77]"
          >
            <span>Começar</span>
            <span className="text-xl font-normal text-[#d8ba77] transition-transform group-hover:translate-x-1">↗</span>
          </button>
          <p className="mt-5 max-w-[290px] text-[10px] uppercase leading-4 tracking-[0.12em] text-[#677d7a]">
            Uma experiência de realidade aumentada.<br />Aponte para o mar.
          </p>
        </div>
      </main>
    );
  }

  if (appState === 'requesting') {
    return <LoadingState />;
  }

  if (appState === 'permission') {
    return (
      <PermissionStateView
        state={permissionState}
        onDemo={enterDemo}
        onRetry={() => void beginExperience()}
      />
    );
  }

  return (
    <main className="horizon-root horizon-grain min-h-[100dvh] bg-[#102124] text-[#eeeade]">
      <div className={`absolute inset-0 overflow-hidden ${isDemo ? 'demo-sky' : 'bg-[#12272a]'}`}>
        <video
          ref={videoRef}
          data-testid="video-camera"
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${isDemo || !stream ? 'opacity-0' : 'opacity-100'}`}
          autoPlay
          muted
          playsInline
        />
        {!isDemo && stream && <div className="absolute inset-0 bg-[#0f2526]/10" />}
        <div className="scanline" />
        <div className="hud-line left-[61%] bottom-[22%] h-[30%]" />
      </div>

      <div className="absolute left-6 top-6 z-20 rounded-2xl border border-[#fffdf3]/10 bg-[#0f2426]/70 p-3 text-[9px] uppercase tracking-[0.15em] text-[#fffdf3] shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur-sm">
        <div className="mb-2 flex items-center justify-between gap-3 text-[10px] font-semibold text-[#d8ba77]">
          <span>DIAGNÓSTICO</span>
          <span className="font-mono text-[9px] text-[#a7d4c9]">live</span>
        </div>
        <div className="space-y-1 text-[10px] leading-4 text-[#e8efe9]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#a7d4c9]/80">heading</span>
            <span className="font-mono text-[11px]">{heading}°</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#a7d4c9]/80">poi</span>
            <span className="font-mono text-[11px]">{diagnosticTarget?.name ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#a7d4c9]/80">bearing</span>
            <span className="font-mono text-[11px]">{diagnosticTarget?.bearing !== undefined ? `${diagnosticTarget.bearing}°` : '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#a7d4c9]/80">dif</span>
            <span className="font-mono text-[11px]">{diagnosticDelta !== undefined ? `${Math.round(diagnosticDelta)}°` : '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#a7d4c9]/80">dist</span>
            <span className="font-mono text-[11px]">{diagnosticTarget?.distanceKm !== undefined ? formatDistance(diagnosticTarget.distanceKm) : '—'}</span>
          </div>
        </div>
      </div>

      <header className="safe-top absolute inset-x-0 top-0 z-10 flex items-start justify-between px-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.34em] text-[#eeeade]">HORIZON</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <div className="flex items-baseline gap-3 text-[10px] uppercase tracking-[0.2em] text-[#eeeade]">
            <span className="text-[#d8ba77]">{getCardinal(heading)}</span>
            <span className="font-mono text-[11px] tracking-[0.08em] text-[#eeeade]/80">{heading}°</span>
          </div>
          <span className={`font-mono text-[7px] uppercase tracking-[0.14em] ${sensorStatus === 'active' ? 'text-[#a7d4c9]/55' : 'text-[#d8ba77]/55'}`}>
            sensor: {sensorStatus}
          </span>
        </div>
      </header>

      <div className="absolute right-6 top-[15%] z-10 text-right font-mono text-[7px] uppercase leading-4 tracking-[0.12em] text-[#a7d4c9]/55">
        <p className={location.status === 'active' ? 'text-[#a7d4c9]/75' : 'text-[#d8ba77]/60'}>
          GPS • {location.status === 'active' ? 'ACTIVE' : isDemo ? 'TESTE' : 'WAITING'}
        </p>
        {location.latitude !== null && <p>LAT {formatCoordinate(location.latitude)}</p>}
        {location.longitude !== null && <p>LON {formatCoordinate(location.longitude)}</p>}
        {location.accuracy !== null && <p>±{Math.round(location.accuracy)} m</p>}
      </div>

      {visiblePoints
        .filter((point) => result.name !== point.name)
        .map((point) => (
          <div
            key={point.id}
            className="absolute z-10 max-w-[130px] -translate-x-1/2 text-center text-[#fffdf3]/80"
            style={{ left: `${point.position.left}%`, top: `${point.position.top}%` }}
          >
            <p className="text-[9px] uppercase leading-3 tracking-[0.12em]">{point.name}</p>
            <p className="mt-1 font-mono text-[9px] tracking-[0.08em] text-[#a7d4c9]/75">{formatDistance(point.distanceKm)}</p>
          </div>
        ))}

      <section
        className="result-readout absolute top-[45%] z-10 -translate-x-1/2"
        style={{ left: `${result.position?.left ?? 61}%` }}
      >
        <div className="max-w-[210px]">
          <h2 data-testid="text-result-continent" className="font-serif text-[44px] leading-none tracking-[-0.035em] text-[#fffdf3]">
            {result.state === 'calculating' ? 'CALCULANDO...' : result.name ?? 'AGUARDANDO LEITURA'}
          </h2>
          <p className="mt-2 text-[10px] uppercase tracking-[0.24em] text-[#fffdf3]/75">
            {result.state === 'poi' ? 'Ponto de interesse' : result.state === 'ocean' ? 'Nenhuma terra encontrada' : result.state === 'no-location' ? 'Localização necessária' : result.state === 'unavailable' ? 'Dados indisponíveis' : 'Próxima terra firme'}
          </p>
          {result.distanceKm !== undefined && (
            <p data-testid="text-result-distance" className="mt-3 font-mono text-[12px] tracking-[0.1em] text-[#fffdf3]/90">{formatDistance(result.distanceKm)}</p>
          )}
          {result.detail && <p className="mt-2 text-[9px] uppercase tracking-[0.12em] text-[#a7d4c9]/60">{result.detail}</p>}
        </div>
      </section>

      <button
        type="button"
        data-testid="button-demo-mode"
        onClick={toggleDemo}
        className="absolute bottom-[15.5%] right-6 z-10 rounded-full border border-[#fffdf3]/15 bg-[#102124]/20 px-3 py-2 text-[8px] uppercase tracking-[0.16em] text-[#fffdf3]/60 backdrop-blur-md transition-colors hover:border-[#d8ba77]/60 hover:text-[#eeeade]"
      >
        {isDemo ? 'Demonstração · ativa' : 'Demonstração'}
      </button>

      <footer className="safe-bottom absolute inset-x-0 bottom-0 z-10 flex items-center justify-between px-6">
        <button
          type="button"
          data-testid="button-signal"
          aria-label="Abrir dados do sinal"
          onClick={() => setSheet('signal')}
          className="px-1 py-3 text-[10px] uppercase tracking-[0.22em] text-[#fffdf3]/70 transition-colors hover:text-[#d8ba77]"
        >
          Mapa
        </button>
        <button
          type="button"
          data-testid="button-capture"
          aria-label="Capturar leitura"
          onClick={takeCapture}
          className={`relative flex h-[70px] w-[70px] items-center justify-center rounded-full border border-[#d8ba77]/70 bg-[#d8ba77]/10 text-[#d8ba77] transition-transform hover:scale-105 active:scale-95 ${isCapturing ? 'scale-95' : ''}`}
        >
          <span className="absolute inset-[5px] rounded-full border border-[#d8ba77]/25" />
          <span className="h-[45px] w-[45px] rounded-full border border-[#d8ba77]/70" />
          {captureNotice && <span className="absolute bottom-[-25px] left-1/2 w-[130px] -translate-x-1/2 text-center text-[8px] uppercase tracking-[0.2em] text-[#d8ba77]">{captureNotice}</span>}
        </button>
        <button
          type="button"
          data-testid="button-about"
          aria-label="Sobre o HORIZON"
          onClick={() => setSheet('about')}
          className="px-1 py-3 text-[10px] uppercase tracking-[0.22em] text-[#fffdf3]/70 transition-colors hover:text-[#d8ba77]"
        >
          Sobre
        </button>
      </footer>

      {sheet && (
        <InfoSheet
          kind={sheet}
          onClose={() => setSheet(null)}
          heading={heading}
          location={location}
          result={result}
        />
      )}
    </main>
  );
}

function LoadingState() {
  return (
    <main className="horizon-root horizon-grain flex min-h-[100dvh] flex-col items-center justify-center bg-[#06090a] px-8 text-center text-[#eeeade]">
      <div className="orbit relative mb-9 h-16 w-16 rounded-full border border-[#a7d4c9]/20">
        <div className="absolute left-1/2 top-[-3px] h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-[#d8ba77]" />
        <div className="absolute inset-[11px] rounded-full border border-[#d8ba77]/45" />
      </div>
      <p className="text-[11px] uppercase tracking-[0.34em] text-[#eeeade]">Preparando o horizonte</p>
      <p className="mt-3 max-w-[220px] text-[12px] leading-5 text-[#829795]">Pedimos acesso à câmera e aos sensores para encontrar a próxima terra.</p>
      <div className="mt-8 h-px w-36 overflow-hidden bg-[#a7d4c9]/15"><div className="h-full w-1/2 animate-pulse bg-[#d8ba77]/70" /></div>
    </main>
  );
}

function PermissionStateView({ state, onDemo, onRetry }: { state: PermissionState; onDemo: () => void; onRetry: () => void }) {
  const title = state === 'unsupported' ? 'Este dispositivo não vê a câmera.' : 'A câmera ficou de fora.';
  const body = state === 'unsupported'
    ? 'O HORIZON continua disponível como instrumento de demonstração neste navegador.'
    : 'Sem problema. Você pode permitir o acesso nas definições do navegador ou continuar com uma leitura simulada.';

  return (
    <main className="horizon-root horizon-grain flex min-h-[100dvh] flex-col justify-between bg-[#091314] px-7 py-8 text-[#eeeade]">
      <div className="safe-top flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-[#8aa4a1]">
        <span>HORIZON</span><span className="font-mono text-[#d8ba77]">sem bloqueios</span>
      </div>
      <section className="onboarding-enter">
        <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-full border border-[#d88772]/45 text-[#d88772]">
          <X size={21} strokeWidth={1} />
        </div>
        <p className="mb-3 text-[10px] uppercase tracking-[0.27em] text-[#d88772]">acesso incompleto</p>
        <h1 className="max-w-[300px] font-serif text-[42px] leading-[0.96] tracking-[-0.035em]">{title}</h1>
        <p data-testid="status-permission" className="mt-6 max-w-[300px] text-[14px] leading-6 text-[#9aaba8]">{body}</p>
      </section>
      <div className="safe-bottom">
        <button type="button" data-testid="button-use-demo" onClick={onDemo} className="mb-4 flex w-full items-center justify-between border-b border-[#d8ba77]/60 pb-4 text-left text-[12px] font-semibold uppercase tracking-[0.2em] text-[#eeeade]">
          <span>Usar demonstração</span><span className="text-xl text-[#d8ba77]">↗</span>
        </button>
        {state !== 'unsupported' && (
          <button type="button" data-testid="button-retry-camera" onClick={onRetry} className="flex w-full items-center justify-center gap-2 py-3 text-[10px] uppercase tracking-[0.2em] text-[#8aa4a1] transition-colors hover:text-[#eeeade]">
            <RotateCcw size={13} strokeWidth={1.2} /> tentar novamente
          </button>
        )}
      </div>
    </main>
  );
}

function InfoSheet({ kind, onClose, heading, location, result }: { kind: 'about' | 'signal'; onClose: () => void; heading: number; location: HorizonLocation; result: HorizonResult }) {
  const isAbout = kind === 'about';
  return (
    <div className="absolute inset-0 z-30 flex items-end bg-[#06090a]/35 backdrop-blur-[2px]" role="dialog" aria-modal="true" data-testid={`sheet-${kind}`}>
      <div className="glass-panel w-full rounded-t-[26px] px-6 pb-[max(1.75rem,env(safe-area-inset-bottom))] pt-5 text-[#eeeade]">
        <div className="mb-8 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-[0.25em] text-[#a7d4c9]">{isAbout ? 'sobre o instrumento' : 'telemetria da leitura'}</p>
          <button type="button" data-testid="button-close-sheet" aria-label="Fechar painel" onClick={onClose} className="rounded-full p-2 text-[#a7d4c9] transition-colors hover:text-[#d8ba77]"><X size={18} strokeWidth={1.2} /></button>
        </div>
        {isAbout ? (
          <>
            <h2 className="max-w-[300px] font-serif text-[34px] leading-none tracking-[-0.03em]">Uma pergunta<br /><em className="text-[#d8ba77]">sobre o depois.</em></h2>
            <p className="mt-6 max-w-[340px] text-[13px] leading-6 text-[#9aaba8]">HORIZON é um protótipo de realidade aumentada para tornar o planeta legível. Ele combina direção, posição e uma linha de visão para indicar o que existe além do mar.</p>
            <p className="mt-4 text-[10px] uppercase leading-5 tracking-[0.14em] text-[#677d7a]">Os dados apresentados nesta versão são uma leitura conceitual do cenário Copacabana. Nenhuma imagem ou posição é enviada.</p>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-y-7">
              <Metric label="alvo" value={result.name ?? 'aguardando'} detail={result.state === 'poi' ? 'ponto de interesse' : 'próxima terra firme'} />
              <Metric label="azimute" value={`${heading}° ${getCardinal(heading)}`} detail="direção do iPhone" />
              <Metric label="distância" value={result.distanceKm !== undefined ? formatDistance(result.distanceKm) : '—'} detail="estimativa geodésica" />
              <Metric label="GPS" value={location.status === 'active' ? 'ativo' : 'aguardando'} detail={location.accuracy !== null ? `precisão ±${Math.round(location.accuracy)} m` : 'posição atual'} />
            </div>
            <div className="mt-8 border-t border-[#a7d4c9]/15 pt-4 text-[9px] uppercase tracking-[0.18em] text-[#677d7a]">Algoritmo geográfico · demonstração 0.1</div>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.18em] text-[#d8ba77]">{label}</p>
      <p className="mt-2 max-w-[145px] text-[14px] leading-5 text-[#eeeade]">{value}</p>
      <p className="mt-1 max-w-[145px] text-[10px] leading-4 text-[#7f9390]">{detail}</p>
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function App() {
  return (
    <WouterRouter base="/Horizon">
      <Router />
    </WouterRouter>
  );
}

export default App;