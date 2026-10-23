/*global QUnit*/

sap.ui.define([
	"com/luxasia/campaignmanagement/util/campaignService"
], function (campaignService) {
	"use strict";

	QUnit.module("campaignService validation");

	QUnit.test("Create needs description and an allowed country", function (assert) {
		assert.strictEqual(campaignService.validate({ description: "Dyson", country: "SG" }).length, 0);
		assert.strictEqual(campaignService.validate({ description: "", country: "SG" })[0].field, "description");
		assert.strictEqual(campaignService.validate({ description: "Dyson", country: "US" })[0].field, "country");
	});

	QUnit.test("Change needs the campaign ID", function (assert) {
		assert.strictEqual(campaignService.validate({ description: "Dyson", country: "SG" }, "")[0].field, "id");
		assert.strictEqual(campaignService.validate({ description: "Dyson", country: "SG" }, "C-00000001").length, 0);
	});

});
