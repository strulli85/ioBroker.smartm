"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");

class Smartm extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - some options
	 */
	constructor(options) {
		super({
			...options,
			name: "smartm",
		});

		this.accessToken = null;
		this.powerStationIds = [];

		this.on("ready", this.onReady.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		if (!this.config.server) {
			this.setState("info.connection", false, true);
			this.terminate(
				`Server is empty - please check instance configuration of ${this.namespace}`,
				utils.EXIT_CODES.INVALID_ADAPTER_CONFIG,
			);
			return;
		}

		if (!this.config.username || !this.config.password) {
			this.setState("info.connection", false, true);
			this.terminate(
				`User name and/or user password empty - please check instance configuration of ${this.namespace}`,
				utils.EXIT_CODES.INVALID_ADAPTER_CONFIG,
			);
			return;
		}

		this.reLoginTimeout = null;
		this.reloadFlowDataInterval = null;
		this.reloadStatisticsInterval = null;
		this.login();
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - callback function
	 */
	onUnload(callback) {
		try {
			this.setState("info.connection", false, true);
			this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
			this.reloadFlowDataInterval && clearInterval(this.reloadFlowDataInterval);
			this.reloadStatisticsInterval && clearInterval(this.reloadStatisticsInterval);
			callback();
		} catch (error) {
			this.log.error(`Error in Unload Function: ${error}`);
			callback();
		}
	}

	/*
	 * Login to smart-m server and obtain access token
	 */
	async login() {
		this.log.info(`login to smart-m server ${this.config.server}`);

		//stop previous intervals
		this.reloadFlowDataInterval && clearInterval(this.reloadFlowDataInterval);
		this.reloadFlowDataInterval = null;

		this.reloadStatisticsInterval && clearInterval(this.reloadStatisticsInterval);
		this.reloadStatisticsInterval = null;
		try {
			const response = await axios.post(`https://${this.config.server}/backend/slenergy-sys/sys/login`, {
				captcha: "",
				checkKey: "",
				username: this.config.username,
				password: this.config.password,
				remember_me: true,
			});
			if (response.data.success) {
				this.log.info("Login successful");
				this.setState("info.connection", true, true);
				this.accessToken = response.data.result.token;
				this.parseUserInfo(response.data.result.userInfo);
				this.parsePowerStationList(response.data.result.powerStationList);

				//start reloading flow data every minute
				this.reloadFlowData();
				this.reloadFlowDataInterval = setInterval(() => {
					this.reloadFlowData();
				}, 1000 * 60);

				//start reloading statistics every minute
				this.reloadStatistics();
				this.reloadStatisticsInterval = setInterval(() => {
					this.reloadStatistics();
				}, 1000 * 60);
			} else {
				this.setState("info.connection", false, true);
				this.log.error(`Login failed: ${JSON.stringify(response.data, null, 2)}`);
				//retry login in 1 minute
				this.reLoginTimeout = setTimeout(() => {
					this.login();
				}, 1000 * 60);
			}
		} catch (error) {
			this.setState("info.connection", false, true);
			this.log.error(`Error obtaining access token: ${error}`);
			//retry login in 1 minute
			this.reLoginTimeout = setTimeout(() => {
				this.login();
			}, 1000 * 60);
		}
	}

	/*
	 * parse UserInfo from login response
	 * @param {object} userInfo - user info object from login response
	 */
	parseUserInfo(userInfo) {
		this.log.debug("Parsing user info");

		//create subtree for userInfo
		this.setObjectNotExists("userInfo", {
			type: "channel",
			common: {
				name: "Benutzerinformationen",
			},
			native: {},
		});

		this.parseData("userInfo", userInfo);
	}

	/*
	 * parse PowerStationList from login response
	 * @param {array} powerStationList - array of power station objects from login response
	 */
	parsePowerStationList(powerStationList) {
		this.log.debug("Parsing power station list");

		//create subtree for powerStationList
		this.setObjectNotExists("powerStationList", {
			type: "channel",
			common: {
				name: "Anlageninformationen",
			},
			native: {},
		});

		//create a subtree for each powerStation
		this.powerStationIds = [];
		for (const powerStation of powerStationList) {
			this.powerStationIds.push(powerStation.id);
			this.setObjectNotExists(`powerStationList.${powerStation.id}`, {
				type: "channel",
				common: {
					name: powerStation.powerStationName,
				},
				native: {},
			});

			//fill each powerStation subtree with data
			this.parseData(`powerStationList.${powerStation.id}`, powerStation);
		}
	}

	/*
	 * Reload flow data for all power stations
	 */
	async reloadFlowData() {
		this.log.debug("Reloading flow data from smart-m server");

		for (const powerStationId of this.powerStationIds) {
			this.log.debug(`Reloading flow data of plant ${powerStationId}`);
			try {
				const currentDate = new Date();
				const response = await axios.post(
					`https://${this.config.server}/backend/slenergy-ops/ops/energy/storage/home/flow`,
					{
						powerStationId: powerStationId,
						year: currentDate.getFullYear(),
						month: currentDate.getMonth() + 1, //month is zero based
						day: currentDate.getDate(),
					},
					{
						headers: {
							"X-Access-Token": this.accessToken,
						},
					},
				);
				if (response.data.success) {
					this.log.debug(`flow data request successful${JSON.stringify(response.data, null, 2)}`);

					this.setObjectNotExists(`powerStationList.${powerStationId}.flow`, {
						type: "channel",
						common: {
							name: `powerStationList.${powerStationId}.flow`,
						},
						native: {},
					});

					this.parseData(`powerStationList.${powerStationId}.flow`, response.data.result);
				} else {
					this.log.error(`reading flow data failed: ${JSON.stringify(response.data, null, 2)}`);
					//retry login in 1 minute
					this.reLoginTimeout = setTimeout(() => {
						this.login();
					}, 1000 * 60);
					return;
				}
			} catch (error) {
				this.log.error(`reading flow data failed: ${error}`);
				//retry login in 1 minute
				this.reLoginTimeout = setTimeout(() => {
					this.login();
				}, 1000 * 60);
				return;
			}
		}
	}

	/*
	 * Reload statistics
	 */
	async reloadStatistics() {
		this.log.debug("Reloading statistics from smart-m server");

		for (const powerStationId of this.powerStationIds) {
			this.log.debug(`Reloading statistic of plant ${powerStationId}`);
			try {
				const response = await axios.get(
					`https://${this.config.server}/backend/slenergy-ops/ops/energy/storage/overview-statistics/${
						powerStationId
					}`,
					{
						headers: {
							"X-Access-Token": this.accessToken,
						},
					},
				);
				if (response.data.success) {
					this.log.debug(`statistic data request successful${JSON.stringify(response.data, null, 2)}`);

					this.setObjectNotExists(`powerStationList.${powerStationId}.statistics`, {
						type: "channel",
						common: {
							name: `powerStationList.${powerStationId}.statistics`,
						},
						native: {},
					});

					this.parseData(`powerStationList.${powerStationId}.statistics`, response.data.result);
				} else {
					this.log.error(`reading statistics failed: ${JSON.stringify(response.data, null, 2)}`);
					//retry login in 1 minute
					this.reLoginTimeout = setTimeout(() => {
						this.login();
					}, 1000 * 60);
					return;
				}
			} catch (error) {
				this.log.error(`reading statistics data failed: ${error}`);
				//retry login in 1 minute
				this.reLoginTimeout = setTimeout(() => {
					this.login();
				}, 1000 * 60);
				return;
			}
		}
	}

	parseData(parentIoBrokerId, jsonObject) {
		const objectKeys = Object.keys(jsonObject);
		for (const key of objectKeys) {
			const jsType = typeof jsonObject[key];
			const iobId = `${parentIoBrokerId}.${key}`;

			if (jsType === "object") {
				if (jsonObject[key] !== null) {
					this.setObjectNotExists(iobId, {
						type: "channel",
						common: {
							name: iobId,
						},
						native: {},
					});
					this.parseData(iobId, jsonObject[key]);
				}
			} else {
				//create state
				let iobType;
				switch (jsType) {
					case "number":
						iobType = "number";
						break;
					case "string":
						iobType = "string";
						break;
					case "boolean":
						iobType = "boolean";
						break;
					default:
						iobType = "string";
				}

				this.setObjectNotExists(iobId, {
					type: "state",
					common: {
						name: iobId,
						type: iobType,
						role: "state",
						read: true,
						write: false,
					},
					native: {},
				});

				this.setStateChanged(iobId, jsonObject[key], true);
			}
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - some options
	 */
	module.exports = options => new Smartm(options);
} else {
	// otherwise start the instance directly
	new Smartm();
}
