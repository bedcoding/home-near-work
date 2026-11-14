import L from 'leaflet';
import { ref, watch } from 'vue';
import { distanceText } from './format';
import type { NearInfo } from './subwayNear';
import dataUrl from './subway-lines.json?url';

// 지도에 까는 수도권 전철 노선. 자료는 scripts/build-subway-lines.mjs가 OpenStreetMap에서 받아 줄인 web/src/subway-lines.json이다.
// - 노선 색으로 늘 그린다. 지도 아래 '지하철 노선'으로 끄고 켜며, 모든 지도가 같이 쓴다(이 브라우저 localStorage 'hnw-subway-lines').
// - 거리 핀에서 NEAR_M 안에 역이 있는 노선(갈아타지 않고 그 핀까지 가는 노선)은 굵고 진하게, 나머지는 가늘고 옅게 그린다.
//   거리 핀이 없거나 근처에 역이 없으면 모두 보통 굵기로 그린다.
// - 노선이나 역에 마우스를 올리면 그 노선만 굵게 하고 나머지는 흐리게 한다. 노선 툴팁에 이름과 강조한 까닭(가까운 핀과 역)을 쓴다.

export interface SubwayLine {
  /** 역 목록(server/stations-kric.json)과 같은 노선 이름 */
  name: string;
  /** 역 목록에서 이 노선으로 칠 다른 이름(1호선 북쪽 구간의 '경원선') */
  aliases: string[];
  color: string;
  /** 선마다 [위도, 경도, 위도, 경도, …] */
  paths: number[][];
}
export interface SubwayData {
  source: string;
  baseDate: string;
  lines: SubwayLine[];
}

export { NEAR_M, nearLines, type NearInfo } from './subwayNear';

const KEY = 'hnw-subway-lines';
function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}
export const subwayOn = ref(readOn());
watch(subwayOn, (on) => {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* 기억만 못 함 */
  }
});

/** 받은 노선 자료의 기준일(지도 설명 창에 쓴다). 자료 자체는 크고 화면에 묶을 일이 없어 반응형으로 두지 않는다. */
export const subwayBaseDate = ref<string | null>(null);
let loading: Promise<SubwayData> | null = null;
export function loadSubway(): Promise<SubwayData> {
  loading ??= fetch(dataUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`노선 자료를 못 받음(${r.status})`);
      return r.json() as Promise<SubwayData>;
    })
    .then((d) => {
      subwayBaseDate.value = d.baseDate;
      return d;
    })
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

type Look = 'normal' | 'strong' | 'weak' | 'focus' | 'dim';
/** 노선 모양. casing은 노선 밑에 까는 흰 테두리의 진하기(0이면 안 깜). */
const LOOKS: Record<Look, { weight: number; opacity: number; casing: number }> = {
  normal: { weight: 4, opacity: 0.8, casing: 0.7 },
  strong: { weight: 5, opacity: 0.95, casing: 0.85 },
  // 수인분당선(노랑)이나 9호선(황토)처럼 밝은 노선도 지도 바탕에서 보이게 너무 옅게 하지 않는다.
  weak: { weight: 3, opacity: 0.65, casing: 0 },
  focus: { weight: 7, opacity: 1, casing: 0.95 },
  dim: { weight: 3, opacity: 0.15, casing: 0 },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 노선 좌표를 Leaflet 좌표로 한 번만 바꿔 두고 여러 지도(매물, 경매, 노선 탭)와 흰 테두리가 같이 쓴다. */
const latlngCache = new WeakMap<SubwayLine, L.LatLng[][]>();
function latlngsOf(line: SubwayLine): L.LatLng[][] {
  let v = latlngCache.get(line);
  if (!v) {
    v = line.paths.map((flat) => {
      const pts: L.LatLng[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push(L.latLng(flat[i], flat[i + 1]));
      return pts;
    });
    latlngCache.set(line, v);
  }
  return v;
}

interface Drawn {
  line: SubwayLine;
  stroke: L.Polyline;
  casing: L.Polyline;
  near: NearInfo | null;
}

/** 지도 한 장의 노선 층. 자료를 받은 뒤 setData로 한 번 그리고, 거리 핀이나 마우스에 따라 모양만 바꾼다. */
export class SubwayLayer {
  private readonly group = L.layerGroup();
  private drawn: Drawn[] = [];
  /** 노선 이름과 다른 이름 → 노선 */
  private readonly byName = new Map<string, Drawn>();
  private near = new Map<string, NearInfo>();
  /** 마우스를 올린 노선과 어디에 올렸는지(역 표시를 다시 그릴 때는 역에서 온 것만 푼다) */
  private focused: { lines: Set<Drawn>; from: 'line' | 'station' } | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly renderer: L.Renderer,
  ) {}

  setData(data: SubwayData) {
    if (this.drawn.length) return;
    const style = { renderer: this.renderer, lineCap: 'round' as const, lineJoin: 'round' as const };
    this.drawn = data.lines.map((line) => {
      const latlngs = latlngsOf(line);
      const casing = L.polyline(latlngs, { ...style, color: '#fff', interactive: false });
      const stroke = L.polyline(latlngs, { ...style, color: line.color, className: 'subway-line' });
      return { line, stroke, casing, near: null };
    });
    // 흰 테두리를 모두 먼저 깔아야 테두리가 다른 노선을 덮지 않는다.
    for (const d of this.drawn) d.casing.addTo(this.group);
    for (const d of this.drawn) {
      d.stroke
        .bindTooltip(() => this.tipOf(d), { sticky: true, direction: 'top', offset: [0, -10] })
        .on('mouseover', () => this.focus([d], 'line'))
        .on('mouseout', () => this.unfocus('line'))
        .addTo(this.group);
      for (const n of [d.line.name, ...d.line.aliases]) this.byName.set(n, d);
    }
    this.applyNear();
  }

  setVisible(on: boolean) {
    if (on === this.map.hasLayer(this.group)) return;
    if (on) {
      this.group.addTo(this.map);
      this.restyle();
      this.raiseNear();
    } else {
      this.focused = null;
      this.group.remove();
    }
  }

  /** 거리 핀 근처 역의 노선(nearLines 결과)을 받아 강조를 바꾼다. */
  setNear(near: Map<string, NearInfo>) {
    this.near = near;
    this.applyNear();
  }

  /** 역에 마우스를 올렸을 때 그 역 노선(역 목록 이름)만 굵게 한다. 모르는 노선뿐이면 그대로 둔다. */
  focusNames(names: readonly string[]) {
    const lines = names.map((n) => this.byName.get(n)).filter((d): d is Drawn => !!d);
    if (lines.length) this.focus(lines, 'station');
  }

  /** from에서 온 강조만 푼다(없으면 무엇이든). */
  unfocus(from?: 'line' | 'station') {
    if (!this.focused || (from && this.focused.from !== from)) return;
    this.focused = null;
    this.restyle();
  }

  private focus(lines: Drawn[], from: 'line' | 'station') {
    this.focused = { lines: new Set(lines), from };
    this.restyle();
  }

  private applyNear() {
    for (const d of this.drawn) {
      let best: NearInfo | null = null;
      for (const n of [d.line.name, ...d.line.aliases]) {
        const v = this.near.get(n);
        if (v && (!best || v.m < best.m)) best = v;
      }
      d.near = best;
    }
    this.restyle();
    this.raiseNear();
  }

  private lookOf(d: Drawn, anyNear: boolean): Look {
    if (this.focused) return this.focused.lines.has(d) ? 'focus' : 'dim';
    if (!anyNear) return 'normal';
    return d.near ? 'strong' : 'weak';
  }

  private restyle() {
    const anyNear = this.drawn.some((d) => d.near);
    for (const d of this.drawn) {
      const look = LOOKS[this.lookOf(d, anyNear)];
      d.stroke.setStyle({ weight: look.weight, opacity: look.opacity });
      d.casing.setStyle({ weight: look.weight + 3, opacity: look.casing });
    }
  }

  /**
   * 거리 핀 근처 노선을 위로 올린다. 테두리도 같이 올려 아래 노선과 겹친 자리가 끊겨 보이게 한다.
   * 마우스를 올릴 때는 순서를 바꾸지 않는다. 마우스 아래의 선을 옮기면 브라우저가 mouseout을 놓쳐 강조가 풀리지 않는다.
   */
  private raiseNear() {
    if (!this.map.hasLayer(this.group)) return;
    for (const d of this.drawn) {
      if (!d.near) continue;
      d.casing.bringToFront();
      d.stroke.bringToFront();
    }
  }

  private tipOf(d: Drawn): string {
    const why = d.near
      ? `<br><span class="st-tip">거리 핀 '${esc(d.near.pin)}'에서 ${distanceText(d.near.m)} 떨어진 ${esc(d.near.station)}을 지납니다</span>`
      : '';
    return `<b>${esc(d.line.name)}</b>${why}`;
  }
}
