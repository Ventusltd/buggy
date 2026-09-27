"""The scripted drive used by the golden reference: the same schedule as tools/golden-dynamics.mjs."""


def scripted(t):
    if t < 1:
        return dict(throttle=0, brake=0, steer=0, gear=1)
    if t < 3:
        return dict(throttle=0.8, brake=0, steer=0, gear=1)
    if t < 4:
        return dict(throttle=0.4, brake=0, steer=0.6, gear=1)
    if t < 5:
        return dict(throttle=0, brake=0.7, steer=0.2, gear=1)
    return dict(throttle=0.5, brake=0, steer=-0.8, gear=1)
