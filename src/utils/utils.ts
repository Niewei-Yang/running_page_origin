import * as mapboxPolyline from '@mapbox/polyline';
import gcoord from 'gcoord';
import { WebMercatorViewport } from '@math.gl/web-mercator';
import { RPGeometry } from '@/static/run_countries';
import { chinaCities } from '@/static/city';
import {
  MAIN_COLOR,
  MUNICIPALITY_CITIES_ARR,
  NEED_FIX_MAP,
  RUN_TITLES,
  ACTIVITY_TYPES,
  RICH_TITLE,
  HIKING_COLOR,
  WALKING_COLOR,
  SWIMMING_COLOR,
  getRuntimeRunColor,
  RUN_TRAIL_COLOR,
  MAP_TILE_STYLES,
  MAP_TILE_STYLE_DARK,
  IS_CHINESE,
  getCyclingColor,
} from './const';
import {
  FeatureCollection,
  LineString,
  Feature,
  GeoJsonProperties,
} from 'geojson';
import { getMapThemeFromCurrentTheme } from '@/hooks/useTheme';

export type Coordinate = [number, number];

export type RunIds = Array<number> | [];

export interface Activity {
  run_id: number;
  name: string;
  distance: number;
  moving_time: string;
  type: string;
  subtype: string;
  start_date: string;
  start_date_local: string;
  location_country?: string | null;
  summary_polyline?: string | null;
  average_heartrate?: number | null;
  elevation_gain: number | null;
  average_speed: number;
  streak: number;
}

const titleForShow = (run: Activity): string => {
  const date = run.start_date_local.slice(0, 11);
  const distance = (run.distance / 1000.0).toFixed(2);
  let name = 'Run';
  if (run.name.slice(0, 7) === 'Running') {
    name = 'run';
  }
  if (run.name) {
    name = run.name;
  }
  return `${name} ${date} ${distance} KM ${
    !run.summary_polyline ? '(No map data for this run)' : ''
  }`;
};

const formatPace = (d: number): string => {
  if (Number.isNaN(d)) return '0';
  const pace = (1000.0 / 60.0) * (1.0 / d);
  const minutes = Math.floor(pace);
  const seconds = Math.floor((pace - minutes) * 60.0);
  return `${minutes}'${seconds.toFixed(0).toString().padStart(2, '0')}"`;
};

const convertMovingTime2Sec = (moving_time: string): number => {
  if (!moving_time) {
    return 0;
  }
  // moving_time : '2 days, 12:34:56' or '12:34:56';
  const splits = moving_time.split(', ');
  const days = splits.length == 2 ? parseInt(splits[0]) : 0;
  const time = splits.splice(-1)[0];
  const [hours, minutes, seconds] = time.split(':').map(Number);
  const totalSeconds = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  return totalSeconds;
};

const formatRunTime = (moving_time: string): string => {
  const totalSeconds = convertMovingTime2Sec(moving_time);
  const seconds = totalSeconds % 60;
  const minutes = (totalSeconds - seconds) / 60;
  if (minutes === 0) {
    return seconds + 's';
  }
  return minutes + 'min';
};

// for scroll to the map
const scrollToMap = () => {
  const mapContainer = document.getElementById('map-container');
  if (mapContainer) {
    mapContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

const extractCities = (str: string): string[] => {
  const locations = [];
  let match;
  const pattern = /([\u4e00-\u9fa5]{2,}(市|自治州|特别行政区|盟|地区))/g;
  while ((match = pattern.exec(str)) !== null) {
    locations.push(match[0]);
  }

  return locations;
};

const extractDistricts = (str: string): string[] => {
  const locations = [];
  let match;
  const pattern = /([\u4e00-\u9fa5]{2,}(区|县))/g;
  while ((match = pattern.exec(str)) !== null) {
    locations.push(match[0]);
  }

  return locations;
};

const extractCoordinate = (str: string): [number, number] | null => {
  const pattern = /'latitude': ([-]?\d+\.\d+).*?'longitude': ([-]?\d+\.\d+)/;
  const match = str.match(pattern);

  if (match) {
    const latitude = parseFloat(match[1]);
    const longitude = parseFloat(match[2]);
    return [longitude, latitude];
  }

  return null;
};

const cities = chinaCities.map((c) => c.name);
const locationCache = new Map<number, ReturnType<typeof locationForRun>>();
// what about oversea?
const locationForRun = (
  run: Activity
): {
  country: string;
  province: string;
  city: string;
  coordinate: [number, number] | null;
} => {
  if (locationCache.has(run.run_id)) {
    return locationCache.get(run.run_id)!;
  }
  let location = run.location_country;
  let [city, province, country] = ['', '', ''];
  let coordinate = null;
  if (location) {
    // Only for Chinese now
    // should filter 臺灣
    const cityMatch = extractCities(location);
    const provinceMatch = location.match(/[\u4e00-\u9fa5]{2,}(省|自治区)/);

    if (cityMatch) {
      city = cities.find((value) => cityMatch.includes(value)) as string;

      if (!city) {
        city = '';
      }
    }
    if (provinceMatch) {
      [province] = provinceMatch;
      // try to extract city coord from location_country info
      coordinate = extractCoordinate(location);
    }
    const l = location.split(',');
    // or to handle keep location format
    let countryMatch = l[l.length - 1].match(
      /[\u4e00-\u9fa5].*[\u4e00-\u9fa5]/
    );
    if (!countryMatch && l.length >= 3) {
      countryMatch = l[2].match(/[\u4e00-\u9fa5].*[\u4e00-\u9fa5]/);
    }
    if (countryMatch) {
      [country] = countryMatch;
    }
  }
  if (MUNICIPALITY_CITIES_ARR.includes(city)) {
    province = city;
    if (location) {
      const districtMatch = extractDistricts(location);
      if (districtMatch.length > 0) {
        city = districtMatch[districtMatch.length - 1];
      }
    }
  }

  const r = { country, province, city, coordinate };
  locationCache.set(run.run_id, r);
  return r;
};

const intComma = (x = '') => {
  if (x.toString().length <= 5) {
    return x;
  }
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const pathForRun = (run: Activity): Coordinate[] => {
  try {
    if (!run.summary_polyline) {
      return [];
    }
    const c = mapboxPolyline.decode(run.summary_polyline);
    // reverse lat long for mapbox
    c.forEach((arr) => {
      [arr[0], arr[1]] = !NEED_FIX_MAP
        ? [arr[1], arr[0]]
        : gcoord.transform([arr[1], arr[0]], gcoord.GCJ02, gcoord.WGS84);
    });
    // try to use location city coordinate instead , if runpath is incomplete
    if (c.length === 2 && String(c[0]) === String(c[1])) {
      const { coordinate } = locationForRun(run);
      if (coordinate?.[0] && coordinate?.[1]) {
        return [coordinate, coordinate];
      }
    }
    return c;
  } catch (_err) {
    return [];
  }
};

const colorForRun = (run: Activity): string => {
  // 为跑步和骑行分别准备动态颜色变量
  const dynamicRunColor = getRuntimeRunColor();
  const dynamicCyclingColor = getCyclingColor();

  switch (run.type) {
    case 'Run': {
      if (run.subtype === 'trail') {
        return RUN_TRAIL_COLOR;
      }
      // 普通跑步（generic 或其他）统一用动态颜色
      return dynamicRunColor;
    }

    case 'cycling': {
      // 目前所有骑行都用动态颜色
      // 如果以后有特殊 subtype，可以在这里加 if 判断
      return dynamicCyclingColor;
    }

    case 'hiking':
      return dynamicRunColor;

    case 'walking':
      return dynamicRunColor;

    case 'swimming':
      return SWIMMING_COLOR;

    default:
      return SWIMMING_COLOR;
  }
};

const geoJsonForRuns = (runs: Activity[]): FeatureCollection<LineString> => ({
  type: 'FeatureCollection',
  features: runs.map((run) => {
    const points = pathForRun(run);
    const color = colorForRun(run);
    return {
      type: 'Feature',
      properties: {
        color: color,
      },
      geometry: {
        type: 'LineString',
        coordinates: points,
      },
    };
  }),
});

const geoJsonForMap = async (): Promise<FeatureCollection<RPGeometry>> => {
  const [{ chinaGeojson }, worldGeoJson] = await Promise.all([
    import('@/static/run_countries'),
    import('@surbowl/world-geo-json-zh/world.zh.json'),
  ]);

  return {
    type: 'FeatureCollection',
    features: [
      ...worldGeoJson.default.features,
      ...chinaGeojson.features,
    ] as Feature<RPGeometry, GeoJsonProperties>[],
  };
};

const getActivitySport = (act: Activity): string => {
  if (act.type === 'Run') {
    if (act.subtype === 'generic') {
      const runDistance = act.distance / 1000;
      if (runDistance > 20 && runDistance < 40) {
        return RUN_TITLES.HALF_MARATHON_RUN_TITLE;
      } else if (runDistance >= 40) {
        return RUN_TITLES.FULL_MARATHON_RUN_TITLE;
      }
      return ACTIVITY_TYPES.RUN_GENERIC_TITLE;
    } else if (act.subtype === 'trail') return ACTIVITY_TYPES.RUN_TRAIL_TITLE;
    else if (act.subtype === 'treadmill')
      return ACTIVITY_TYPES.RUN_TREADMILL_TITLE;
    else return ACTIVITY_TYPES.RUN_GENERIC_TITLE;
  } else if (act.type === 'hiking') {
    return ACTIVITY_TYPES.HIKING_TITLE;
  } else if (act.type === 'cycling') {
    return ACTIVITY_TYPES.CYCLING_TITLE;
  } else if (act.type === 'walking') {
    return ACTIVITY_TYPES.WALKING_TITLE;
  }
  // if act.type contains 'skiing'
  else if (act.type.includes('skiing')) {
    return ACTIVITY_TYPES.SKIING_TITLE;
  }
  return '';
};

function getTimeOfDay(dateStr: string): string {
  const hour = new Date(dateStr).getHours();
  if (IS_CHINESE) {
    if (hour >= 0 && hour < 9) return '清晨';
    if (hour >= 9 && hour < 12) return '上午';
    if (hour >= 12 && hour < 15) return '午后';
    if (hour >= 15 && hour < 18) return '下午';
    if (hour >= 18 && hour < 21) return '傍晚';
    return '夜晚';
  } else {
    // 英文版（如果你的项目支持多语言）
    if (hour >= 0 && hour < 9) return 'Morning';
    if (hour >= 9 && hour < 12) return 'Late Morning';
    if (hour >= 12 && hour < 15) return 'Afternoon';
    if (hour >= 15 && hour < 18) return 'Late Afternoon';
    if (hour >= 18 && hour < 21) return 'Evening';
    return 'Night';
  }
}

const titleForRun = (run: Activity): string => {
  // 1. 优先使用 Strava 原标题（推荐！）
  if (run.name && run.name.trim() !== '') {
    return run.name.trim();
  }

  // 2. 如果开启 RICH_TITLE，且有城市信息，用 “城市 类型”
  if (RICH_TITLE) {
    const { city } = locationForRun(run);
    const activity_sport = getActivitySport(run);
    if (city && city.length > 0 && activity_sport.length > 0) {
      return `${city} ${activity_sport}`;
    }
  }

  // 3. 最终 fallback：时间段 + 类型（动态选择类型）
  const timePrefix = getTimeOfDay(run.start_date_local);
  const activity_sport = getActivitySport(run);

  // 如果有类型，用类型；否则 fallback 到跑步
  const typeTitle = activity_sport || RUN_TITLES.RUN_GENERIC_TITLE;

  // 距离特殊处理（全马/半马）
  const runDistance = run.distance / 1000;
  if (runDistance >= 42) {
    return `${timePrefix}${RUN_TITLES.FULL_MARATHON_RUN_TITLE}`;
  }
  if (runDistance > 20 && runDistance < 42) {
    return `${timePrefix}${RUN_TITLES.HALF_MARATHON_RUN_TITLE}`;
  }

  return `${timePrefix}${typeTitle}`;
};

export interface IViewState {
  longitude?: number;
  latitude?: number;
  zoom?: number;
}

const getBoundsForGeoData = (
  geoData: FeatureCollection<LineString>
): IViewState => {
  const { features } = geoData;
  let points: Coordinate[] = [];
  // find first have data
  for (const f of features) {
    if (f.geometry.coordinates.length) {
      points = f.geometry.coordinates as Coordinate[];
      break;
    }
  }
  if (points.length === 0) {
    return { longitude: 20, latitude: 20, zoom: 3 };
  }
  if (points.length === 2 && String(points[0]) === String(points[1])) {
    return { longitude: points[0][0], latitude: points[0][1], zoom: 9 };
  }
  // Calculate corner values of bounds
  const pointsLong = points.map((point) => point[0]) as number[];
  const pointsLat = points.map((point) => point[1]) as number[];
  const cornersLongLat: [Coordinate, Coordinate] = [
    [Math.min(...pointsLong), Math.min(...pointsLat)],
    [Math.max(...pointsLong), Math.max(...pointsLat)],
  ];
  const viewState = new WebMercatorViewport({
    width: 800,
    height: 600,
  }).fitBounds(cornersLongLat, { padding: 200 });
  let { longitude, latitude, zoom } = viewState;
  if (features.length > 1) {
    zoom = 11.5;
  }
  return { longitude, latitude, zoom };
};

const filterYearRuns = (run: Activity, year: string) => {
  if (run && run.start_date_local) {
    return run.start_date_local.slice(0, 4) === year;
  }
  return false;
};

const filterCityRuns = (run: Activity, city: string) => {
  if (run && run.location_country) {
    return run.location_country.includes(city);
  }
  return false;
};
const filterTitleRuns = (run: Activity, title: string) =>
  titleForRun(run) === title;

const filterAndSortRuns = (
  activities: Activity[],
  item: string,
  filterFunc: (_run: Activity, _bvalue: string) => boolean,
  sortFunc: (_a: Activity, _b: Activity) => number
) => {
  let s = activities;
  if (item !== 'Total') {
    s = activities.filter((run) => filterFunc(run, item));
  }
  return s.sort(sortFunc);
};

const sortDateFunc = (a: Activity, b: Activity) => {
  return (
    new Date(b.start_date_local.replace(' ', 'T')).getTime() -
    new Date(a.start_date_local.replace(' ', 'T')).getTime()
  );
};
const sortDateFuncReverse = (a: Activity, b: Activity) => sortDateFunc(b, a);

const getMapStyle = (vendor: string, styleName: string, token: string) => {
  const style = (MAP_TILE_STYLES as any)[vendor][styleName];
  if (!style) {
    return MAP_TILE_STYLES.default;
  }
  if (vendor === 'maptiler' || vendor === 'stadiamaps') {
    return style + token;
  }
  return style;
};

const isTouchDevice = () => {
  if (typeof window === 'undefined') return false;
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    window.innerWidth <= 768
  ); // Consider small screens as touch devices
};

/**
 * Determines the appropriate map theme based on current settings
 * @returns The map theme style to use
 */
const getMapTheme = (): string => {
  if (typeof window === 'undefined') return MAP_TILE_STYLE_DARK;

  // Check for explicit theme in DOM
  const dataTheme = document.documentElement.getAttribute('data-theme') as
    | 'light'
    | 'dark'
    | null;

  // Check for saved theme in localStorage
  const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;

  // Determine theme based on priority:
  // 1. DOM attribute
  // 2. localStorage
  // 3. Default to dark theme
  if (dataTheme) {
    return getMapThemeFromCurrentTheme(dataTheme);
  } else if (savedTheme) {
    return getMapThemeFromCurrentTheme(savedTheme);
  } else {
    return getMapThemeFromCurrentTheme('dark');
  }
};

export {
  titleForShow,
  formatPace,
  scrollToMap,
  locationForRun,
  intComma,
  pathForRun,
  geoJsonForRuns,
  geoJsonForMap,
  titleForRun,
  filterYearRuns,
  filterCityRuns,
  filterTitleRuns,
  filterAndSortRuns,
  sortDateFunc,
  sortDateFuncReverse,
  getBoundsForGeoData,
  formatRunTime,
  convertMovingTime2Sec,
  getMapStyle,
  isTouchDevice,
  getMapTheme,
};
