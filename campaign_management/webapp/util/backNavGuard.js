sap.ui.define([], function () {
  "use strict";

  // Single global popstate listener shared by every page that wants a
  // "leave this page?" confirmation on the browser Back button.
  //
  // Root cause #1 this fixes: each page used to attach its own
  // window.addEventListener("popstate", ...) and only remove it when the
  // user left via that SAME page's own back button. Since UI5 caches views
  // (they're hidden, not destroyed) any page left via a forward link/tile
  // kept its listener attached to `window` forever. Later, an unrelated
  // popstate/hash event (e.g. clicking Next on an entirely different page)
  // could be caught by that stale listener and pop up the wrong page's
  // confirmation dialog. Arming a new page now atomically disarms whatever
  // was armed before, so only the page currently on screen can ever react.
  //
  // Root cause #2 this fixes: in Chrome, changing window.location.hash
  // (exactly what UI5's default hash-based router does on every navTo())
  // also dispatches a popstate event, not just hashchange. So a plain
  // forward navigation — no Back button involved — fires the same event a
  // real Back press would. We can't tell those apart from the event alone,
  // but we can tell them apart by the URL: a real Back press lands back on
  // *this* page's own hash (we duplicated it via pushState when arming), while
  // a forward navTo() has already moved the hash on to a different route by
  // the time the event fires. So we only react when the hash is unchanged.
  var _armedHandler = null;
  var _armedHash = null;
  var _listenerAttached = false;

  function _onPopState(oEvent) {
    if (!_armedHandler) {
      return;
    }
    if (window.location.hash !== _armedHash) {
      // Hash already moved on — this popstate was caused by our own forward
      // navigation, not a Back-button press. Ignore it.
      return;
    }
    _armedHandler(oEvent);
  }

  function _ensureListener() {
    if (!_listenerAttached) {
      window.addEventListener("popstate", _onPopState);
      _listenerAttached = true;
    }
  }

  return {
    /**
     * Call from a route's _onRouteMatched once the page is on screen.
     * oController must expose handleBackButton(event).
     */
    arm: function (oController) {
      _ensureListener();
      _armedHandler = oController.handleBackButton.bind(oController);
      _armedHash = window.location.hash;

      // Capture the href now — a forward navTo() that happens before the
      // timeout fires would otherwise cause the closure below to read a
      // *different* (already-navigated-to) location.href, pushing a bogus
      // duplicate history entry for the wrong page and corrupting the
      // hash bookkeeping that _onPopState relies on to tell forward nav
      // apart from a real Back press.
      var sHrefAtArm = location.href;
      var sHashAtArm = _armedHash;
      history.replaceState(null, "", sHrefAtArm);
      setTimeout(function () {
        // If a forward navigation (or a re-arm) happened in the meantime,
        // this scheduled push is stale — skip it so it can't clobber the
        // history entries the newer navigation/arm already set up.
        if (_armedHash !== sHashAtArm) {
          return;
        }
        history.pushState({ page: "guard_" + Math.random() }, "", sHrefAtArm);
      }, 100);
    },

    /**
     * Re-push a fresh history entry without re-binding the handler.
     * Use this when the user cancels the "leave this page?" prompt.
     */
    rearm: function () {
      _armedHash = window.location.hash;
      var sHrefAtArm = location.href;
      var sHashAtArm = _armedHash;
      history.replaceState(null, "", sHrefAtArm);
      setTimeout(function () {
        if (_armedHash !== sHashAtArm) {
          return;
        }
        history.pushState({ page: "guard_" + Math.random() }, "", sHrefAtArm);
      }, 50);
    },

    /**
     * Call before navigating away (forward or confirmed back) so no stale
     * handler can fire for a page that's no longer on screen.
     */
    disarm: function () {
      _armedHandler = null;
      _armedHash = null;
    }
  };
});
