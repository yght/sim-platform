'use strict';

var cb = require('./circuitBreaker');
var CircuitBreaker = cb.CircuitBreaker;
var State = cb.State;

// A hand-cranked clock. The whole reason `now` is injectable is so this
// suite runs in milliseconds instead of waiting out real reset timeouts.
function fakeClock(start) {
  var t = start || 0;
  return {
    now: function () { return t; },
    advance: function (ms) { t = t + ms; }
  };
}

function breaker(clock, overrides) {
  return new CircuitBreaker(Object.assign({
    name: 'vodafone',
    failureThreshold: 3,
    resetTimeoutMs: 90000,
    now: clock.now
  }, overrides || {}));
}

var boom = function () { return Promise.reject({ status: 503 }); };
var ok = function () { return Promise.resolve('done'); };

describe('closed circuit', function () {
  it('starts closed and passes results through', function () {
    var b = breaker(fakeClock());

    expect(b.currentState()).toBe(State.CLOSED);

    return b.run(ok).then(function (result) {
      expect(result).toBe('done');
      expect(b.currentState()).toBe(State.CLOSED);
    });
  });

  it('stays closed while failures are below the threshold', function () {
    var b = breaker(fakeClock());

    return b.run(boom).catch(function () {
      return b.run(boom).catch(function () {
        expect(b.failureCount).toBe(2);
        expect(b.currentState()).toBe(State.CLOSED);
      });
    });
  });

  it('a success resets the failure count', function () {
    var b = breaker(fakeClock());

    return b.run(boom).catch(function () {
      return b.run(ok).then(function () {
        expect(b.failureCount).toBe(0);
      });
    });
  });
});

describe('opening', function () {
  it('opens once the threshold is reached', function () {
    var b = breaker(fakeClock());

    return b.run(boom).catch(function () {})
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () {
        expect(b.currentState()).toBe(State.OPEN);
      });
  });

  it('rejects immediately when open, without calling the carrier', function () {
    var clock = fakeClock();
    var b = breaker(clock);
    var callCount = 0;
    var counted = function () { callCount = callCount + 1; return boom(); };

    return b.run(counted).catch(function () {})
      .then(function () { return b.run(counted).catch(function () {}); })
      .then(function () { return b.run(counted).catch(function () {}); })
      .then(function () {
        expect(callCount).toBe(3);
        return b.run(counted).then(
          function () { throw new Error('should have been rejected'); },
          function (err) {
            expect(err.code).toBe('CIRCUIT_OPEN');
            expect(err.carrier).toBe('vodafone');
            // Still 3 - the fourth call never reached the carrier.
            expect(callCount).toBe(3);
          }
        );
      });
  });

  it('reports how long the caller should wait', function () {
    var clock = fakeClock(1000);
    var b = breaker(clock);

    return b.run(boom).catch(function () {})
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () {
        expect(b.retryAfterMs()).toBe(90000);
        clock.advance(30000);
        expect(b.retryAfterMs()).toBe(60000);
      });
  });
});

describe('half open recovery', function () {
  function tripIt(b) {
    return b.run(boom).catch(function () {})
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () { return b.run(boom).catch(function () {}); });
  }

  it('moves to HALF_OPEN once the reset timeout elapses', function () {
    var clock = fakeClock();
    var b = breaker(clock);

    return tripIt(b).then(function () {
      expect(b.currentState()).toBe(State.OPEN);
      clock.advance(90000);
      expect(b.currentState()).toBe(State.HALF_OPEN);
    });
  });

  it('closes again when the probe succeeds', function () {
    var clock = fakeClock();
    var b = breaker(clock);

    return tripIt(b).then(function () {
      clock.advance(90000);
      return b.run(ok).then(function () {
        expect(b.currentState()).toBe(State.CLOSED);
        expect(b.failureCount).toBe(0);
      });
    });
  });

  it('re-opens and restarts the clock when the probe fails', function () {
    var clock = fakeClock();
    var b = breaker(clock);

    return tripIt(b).then(function () {
      clock.advance(90000);
      expect(b.currentState()).toBe(State.HALF_OPEN);

      return b.run(boom).catch(function () {
        expect(b.currentState()).toBe(State.OPEN);
        // Full timeout again, not the remainder of the old one.
        expect(b.retryAfterMs()).toBe(90000);
      });
    });
  });
});

describe('what counts as a failure', function () {
  it('does not trip on a 404, because that is a healthy no', function () {
    var b = breaker(fakeClock(), {
      isFailure: function (err) { return err.status >= 500; }
    });
    var notFound = function () { return Promise.reject({ status: 404 }); };

    return b.run(notFound).catch(function () {})
      .then(function () { return b.run(notFound).catch(function () {}); })
      .then(function () { return b.run(notFound).catch(function () {}); })
      .then(function () {
        expect(b.currentState()).toBe(State.CLOSED);
        expect(b.failureCount).toBe(0);
      });
  });

  it('still surfaces the original error to the caller', function () {
    var b = breaker(fakeClock());
    var notFound = function () { return Promise.reject({ status: 404, body: 'no such sim' }); };

    return b.run(notFound).then(
      function () { throw new Error('should have rejected'); },
      function (err) { expect(err.body).toBe('no such sim'); }
    );
  });
});

describe('state change notifications', function () {
  it('reports transitions for metrics', function () {
    var clock = fakeClock();
    var b = breaker(clock);
    var seen = [];

    b.onStateChange(function (evt) { seen.push(evt.from + '->' + evt.to); });

    return b.run(boom).catch(function () {})
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () {
        clock.advance(90000);
        b.currentState();
        return b.run(ok);
      })
      .then(function () {
        expect(seen).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
      });
  });

  it('survives a listener that throws, because metrics are not worth an outage', function () {
    var b = breaker(fakeClock());
    b.onStateChange(function () { throw new Error('statsd is down'); });

    return b.run(boom).catch(function () {})
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () { return b.run(boom).catch(function () {}); })
      .then(function () {
        expect(b.currentState()).toBe(State.OPEN);
      });
  });
});
