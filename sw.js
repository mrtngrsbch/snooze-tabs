try {
	// Function to reopen tabs and clean up expired entries
	// Lock to prevent concurrent execution
	let isCheckingTabs = false;

	async function checkForSnoozedTabs() {
		if (isCheckingTabs) {
			console.log(
				"checkForSnoozedTabs is already running. Skipping execution.",
			);
			return;
		}

		isCheckingTabs = true; // Set the lock

		try {
			const now = Date.now();
			const items = await chrome.storage.local.get(null); // Get all stored items

			for (const [key, value] of Object.entries(items)) {
				if (value.snoozeTime && value.snoozeTime <= now) {
					if (value.processing) {
						// Skip entries already being processed
						console.log(`Skipping ${key}, already processing.`);
						continue;
					}

					// Mark as processing to avoid duplicates
					value.processing = true;
					await chrome.storage.local.set({ [key]: value });

					// Reopen the tab
					try {
						await chrome.tabs.create({ url: value.url });
						console.log(`Reopened tab: ${value.url}`);

						// Handle recurring snoozes
						if (value.recurringId) {
							const recurringConfig = items[value.recurringId];
							if (recurringConfig) {
								// Calculate next occurrence
								const [hours, minutes] = recurringConfig.time
									.split(":")
									.map(Number);
								const nextTime = getNextOccurrence(
									hours,
									minutes,
									recurringConfig.days,
								);
								const newAlarmName = `snooze-${Date.now()}-${nextTime.getTime()}`;

								// Create next occurrence
								await chrome.storage.local.set({
									[newAlarmName]: {
										url: value.url,
										title: value.title,
										snoozeTime: nextTime.getTime(),
										recurringId: value.recurringId,
									},
								});

								chrome.alarms.create(newAlarmName, {
									when: nextTime.getTime(),
								});
								console.log(`Created next recurring snooze for: ${value.url}`);
							}
						}

						// Remove the current entry from storage
						await chrome.storage.local.remove(key);
						console.log(`Cleared snooze entry: ${key}`);
					} catch (error) {
						console.error(`Failed to reopen tab for ${key}:`, error);

						// Cleanup processing flag in case of failure
						value.processing = false;
						await chrome.storage.local.set({ [key]: value });
					}
				}
			}
		} catch (error) {
			console.error("Error in checkForSnoozedTabs:", error);
		} finally {
			isCheckingTabs = false; // Release the lock
		}
	}

	// Helper function to get next occurrence for recurring snooze
	function getNextOccurrence(hours, minutes, selectedDays) {
		const now = new Date();
		const result = new Date();
		result.setHours(hours, minutes, 0, 0);

		if (result <= now) {
			result.setDate(result.getDate() + 1);
		}

		while (!selectedDays.includes(result.getDay())) {
			result.setDate(result.getDate() + 1);
		}

		return result;
	}

	function getHoursUntil(targetHour, targetMinute, addDays = 0) {
		const now = new Date();
		const target = new Date(now);
		target.setHours(targetHour, targetMinute, 0, 0);

		if (addDays > 0 || target <= now) {
			target.setDate(target.getDate() + (addDays || 1));
		}

		return (target - now) / (1000 * 60 * 60);
	}

	function getHoursUntilNextDay(targetDay, targetHour, targetMinute) {
		const now = new Date();
		const target = new Date(now);
		target.setHours(targetHour, targetMinute, 0, 0);

		while (target.getDay() !== targetDay || target <= now) {
			target.setDate(target.getDate() + 1);
		}

		return (target - now) / (1000 * 60 * 60);
	}

	function getHoursUntilOneMonth() {
		const now = new Date();

		let target = new Date(
			now.getFullYear(),
			now.getMonth() + 1,
			now.getDate(),
			now.getHours(),
			now.getMinutes(),
			now.getSeconds(),
			now.getMilliseconds(),
		);

		if (target.getMonth() !== (now.getMonth() + 1) % 12) {
			// Use last day of next month at same time
			target = new Date(
				now.getFullYear(),
				now.getMonth() + 2,
				0,
				now.getHours(),
				now.getMinutes(),
				now.getSeconds(),
				now.getMilliseconds(),
			);
		}

		return (target - now) / (1000 * 60 * 60);
	}

	function getWeekendOrMondayHours() {
		const now = new Date();
		const day = now.getDay();
		if (day < 5) {
			return getHoursUntilNextDay(6, 10, 0);
		}
		return getHoursUntilNextDay(1, 9, 0);
	}

	async function snoozeCurrentTab(hours, commandName) {
		const [currentTab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
		if (!currentTab?.url) {
			console.log(`Command ${commandName}: no active tab found to snooze.`);
			return;
		}

		const snoozeTime = Date.now() + hours * 60 * 60 * 1000;
		const alarmName = `snooze-${currentTab.id}-${snoozeTime}`;

		await chrome.storage.local.set({
			[alarmName]: { url: currentTab.url, title: currentTab.title, snoozeTime },
		});

		chrome.alarms.create(alarmName, { when: snoozeTime });
		chrome.tabs.remove(currentTab.id);
		console.log(
			`Command ${commandName}: snoozed tab ${currentTab.url} for ${hours.toFixed(2)} hours.`,
		);
	}

	chrome.commands.onCommand.addListener(async (command) => {
		switch (command) {
			case "snooze-one-month":
				await snoozeCurrentTab(getHoursUntilOneMonth(), command);
				break;
			case "snooze-1hour":
				await snoozeCurrentTab(1, command);
				break;
			case "snooze-tomorrow-morning":
				await snoozeCurrentTab(getHoursUntil(9, 0, 1), command);
				break;
			case "snooze-weekend-or-monday":
				await snoozeCurrentTab(getWeekendOrMondayHours(), command);
				break;
			default:
				console.log(`Unknown command: ${command}`);
		}
	});

	// Listener for alarms
	chrome.alarms.onAlarm.addListener(async (alarm) => {
		console.log(`Alarm triggered: ${alarm.name}`);
		await checkForSnoozedTabs();
	});

	// Periodic fallback (heartbeat)
	const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes
	setInterval(() => {
		console.log("Running fallback heartbeat to check snoozed tabs...");
		checkForSnoozedTabs();
	}, HEARTBEAT_INTERVAL);

	// Debugging: Log when service worker starts
	chrome.runtime.onInstalled.addListener(() => {
		console.log("Tab Snoozer installed");
	});

	chrome.runtime.onStartup.addListener(() => {
		console.log("Tab Snoozer service worker started");
	});
} catch (e) {
	console.log(e);
}
