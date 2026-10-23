sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, backNavGuard) {
    "use strict";

    // Developer reference (prototype "Developer Guide"): screen flow, proposed OData service
    // contracts and open developer checkpoints. Read-only, so back returns to the list without
    // the "leave this page?" popup.
    return Controller.extend("com.luxasia.campaignmanagement.controller.developerGuide", {
        onNavBack: function () {
            backNavGuard.disarm();
            this.getOwnerComponent().getRouter().navTo("campaignList", {}, true);
        }
    });
});
