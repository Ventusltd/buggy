// Vehicle presets for the dynamics cartridge. Pure data, no DOM.
// Every figure is a generic engineering assumption for a class of vehicle, not the data of any product.
// Units: SI (kg, m, N, N m, kg m², s). The Python mirror reads cartridges/dynamics/presets.json,
// which a unit test keeps identical to this file.
//
// Four contacts stand for every vehicle. A multi-axle chassis is represented by an equivalent
// front and rear contact pair per side; that is an assumption, stated in each basis line.

export const PRESETS = Object.freeze({
  'site-buggy': Object.freeze({
    label: 'Generic site buggy',
    basis: 'Two-seat site utility buggy class; rear drive; figures assumed for the class, not measured.',
    mass: 650, Ixx: 180, Iyy: 550, Izz: 700,
    wheelbase: 2.0, track: 1.3, frontLoadFraction: 0.45, cgHeight: 0.55,
    wheelRadius: 0.30, wheelInertia: 3.0,          // spin inertia per wheel incl. reflected driveline (assumed)
    springRate: 30000, damperRate: 1550, travel: 0.12,
    mu: 0.9, tyreB: 10, tyreC: 1.6, slipRefSpeed: 1.0,
    drive: 'rear', driveTorque: 1200, topSpeed: 11.0, reverseTopSpeed: 4.0,
    brakeTorque: 600, rollingResistance: 0.02, dragArea: 1.2,
    turningCircle: 7.0, steerCentre: 'rear'
  }),
  'utility-4x4': Object.freeze({
    label: 'Utility 4x4',
    basis: 'Pick-up / utility four-wheel-drive class; figures assumed for the class, not measured.',
    mass: 2300, Ixx: 900, Iyy: 3900, Izz: 4200,
    wheelbase: 3.1, track: 1.6, frontLoadFraction: 0.55, cgHeight: 0.85,
    wheelRadius: 0.38, wheelInertia: 16.0,
    springRate: 45000, damperRate: 3900, travel: 0.18,
    mu: 0.85, tyreB: 10, tyreC: 1.6, slipRefSpeed: 1.0,
    drive: 'all', driveTorque: 5000, topSpeed: 30.0, reverseTopSpeed: 6.0,
    brakeTorque: 2500, rollingResistance: 0.02, dragArea: 2.4,
    turningCircle: 12.4, steerCentre: 'rear'
  }),
  'rigid-hgv': Object.freeze({
    label: 'Rigid HGV (two-axle, engineering check)',
    basis: 'Two-axle rigid goods vehicle about 18 t gross; figures assumed for the class, for swept-path and access checks only.',
    mass: 18000, Ixx: 16000, Iyy: 85000, Izz: 90000,
    wheelbase: 5.0, track: 2.0, frontLoadFraction: 0.40, cgHeight: 1.40,
    wheelRadius: 0.52, wheelInertia: 100.0,
    springRate: 400000, damperRate: 25500, travel: 0.20,
    mu: 0.8, tyreB: 10, tyreC: 1.6, slipRefSpeed: 3.0,
    drive: 'rear', driveTorque: 30000, topSpeed: 25.0, reverseTopSpeed: 3.0,
    brakeTorque: 15000, rollingResistance: 0.008, dragArea: 6.0,
    turningCircle: 17.0, steerCentre: 'rear'
  }),
  'mobile-crane': Object.freeze({
    label: 'Mobile crane chassis (engineering check)',
    basis: 'All-terrain crane carrier about 48 t, multi-axle reduced to an equivalent four-contact chassis with counter-phase all-wheel steer; figures assumed, for access checks only.',
    mass: 48000, Ixx: 50000, Iyy: 380000, Izz: 400000,
    wheelbase: 7.0, track: 2.5, frontLoadFraction: 0.50, cgHeight: 1.60,
    wheelRadius: 0.65, wheelInertia: 250.0,
    springRate: 1200000, damperRate: 72000, travel: 0.20,
    mu: 0.8, tyreB: 10, tyreC: 1.6, slipRefSpeed: 3.0,
    drive: 'all', driveTorque: 80000, topSpeed: 20.0, reverseTopSpeed: 3.0,
    brakeTorque: 40000, rollingResistance: 0.01, dragArea: 8.0,
    turningCircle: 20.0, steerCentre: 'mid'
  })
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));
