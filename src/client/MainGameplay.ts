import {
	Players,
	ReplicatedStorage,
	RunService,
	TweenService,
	Workspace,
} from '@rbxts/services';

import { $dbg, $print, $warn } from 'rbxts-transform-debug';

import * as Types from 'shared/Types';
import * as Utils from 'shared/Utils';
import { Constants } from 'shared/Constants';
import LZWCompression from 'shared/LZWCompression';

import * as UserInput from './UserInput';
import * as Settings from './Settings';
import * as Topbar from './Topbar';

export let isPlaying = false;

const Compression = new LZWCompression();

const eventsFolder = ReplicatedStorage.WaitForChild('Events') as Types.EventsFolder;
const templatesFolder = ReplicatedStorage.WaitForChild('Templates') as Folder;
const skinsFolder = ReplicatedStorage.WaitForChild('Skins') as Folder;
const songsFolder = ReplicatedStorage.WaitForChild('Songs') as Folder;
const categoryButtonTemplate = templatesFolder.WaitForChild('CategoryButton') as TextButton;
const songButtonTemplate = templatesFolder.WaitForChild('SongButton') as TextButton;
const difficultyButtonTemplate = templatesFolder.WaitForChild('DifficultyButton') as TextButton;

const camera = Workspace.CurrentCamera ?? Workspace.WaitForChild('Camera') as Camera;
const player = Players.LocalPlayer;
const playerGui = player.WaitForChild('PlayerGui') as PlayerGui;
const screenGui = playerGui.WaitForChild('ScreenGui') as Types.UIMain;

const laneHotkeys: UserInput.Hotkey[] = [];

const maxAccuracy = 200;
const minAccuracy = -200;
const defaultHitPosition = 460;
const heldLanes = new Map<number, Types.HoldCreatedNote>();
const laneFrames: Types.UILane[] = [];
const averageError = [0, 0];
const allHitErrors = [[] as number[], [] as number[]];
const hitPositions = [0, 0, 0, 0];
const laneTemplates: { Note: Types.UINote, HoldNote: Types.UIBodyNote, TailNote: Types.UITailNote, BodyNote: Types.UIBodyNote, Lane: Types.UILane }[] = [];

let devAutoPlay = false;
let useAutoplay = false;
let useDebugMode = false;
let originalCameraCFrame: CFrame = CFrame.identity;
let bindedKeys = [Enum.KeyCode.Q, Enum.KeyCode.W, Enum.KeyCode.LeftBracket, Enum.KeyCode.RightBracket];
let laneWidth = 75;
let lanePadding = 1;
let noteSpeed = 10;
let selectedNoteSkin = 'CirclesV1';
let maxVisibleNotes = 200;

let accuracyFormat = '<stroke thickness="2" color="#000" joins="miter"><b>%s</b></stroke>';
let comboFormat = '<stroke thickness="2" color="#000" joins="miter"><b>%d</b></stroke>';

let totalScore = 0;
let maxScore = 0;
let notesMax = 0; // Marvelous
let notes300 = 0; // Perfect
let notes200 = 0; // Good
let notes100 = 0; // Ok
let notes50 = 0; // Bad
let notesMisses = 0;
let noteCombo = 0;
let highestCombo = 0;
let bpm = 0;
let scrollSpeed = 0;
let endTime = 0;

let startTime = os.clock() + 4;
let countdown = 3;

let heldNotes: Types.NoteObject[] = [];
let heldTimings: Types.TimingObject[] = [];
let heldEvents: Types.EventObject[] = [];
let createdNotes: Types.CreatedNote[] = [];
let createdNoteId = 0;

let loadStartTime = os.clock();
let lastPreviewUpdateTime = os.clock();

let stageModel: Types.StageModel | undefined = undefined;
let music: Sound | undefined = undefined;

let startResolve: ((value: Types.RoundStats | Promise<Types.RoundStats>) => void) | undefined = undefined;

if (RunService.IsStudio()) {
	const toggleAutoplay = new UserInput.Hotkey('ToggleAutoplay', Enum.KeyCode.M);
	
	toggleAutoplay.onPress(() => devAutoPlay = !devAutoPlay);
}

Settings.onSettingChanged('LaneWidth', (value) => {
	laneWidth = value;
});

Settings.onSettingChanged('NoteSpeed', (value) => {
	noteSpeed = value;
});

export function calculateAccuracy(nMax: number, n300: number, n200: number, n100: number, n50: number, nMiss: number): number {
	// this is the same as osu!mania's accuracy formula (score v1)
	// https://osu.ppy.sh/wiki/en/Gameplay/Accuracy#osu!mania
	const accuracy = (300 * (nMax + n300) + 200 * n200 + 100 * n100 + 50 * n50) / (300 * (nMax + n300 + n200 + n100 + n50 + nMiss));
	return accuracy * 100;
}

export function calculateDifficulty(chart: Types.Chart) {
	let length = 0;
	for (const note of chart.notes) {
		const noteEndTime = note.type === 1 ? (note.millisecond + note.holdLength) : note.millisecond;
		if (noteEndTime > length) length = noteEndTime;
	}
	
	const timeStep = 7500;
	let highestNoteDensity = 0;
	
	for (const millisecond of $range(0, length, timeStep)) {
		let noteDensity = 0;
		for (const note of chart.notes) {
			if (note.millisecond >= millisecond && note.millisecond <= millisecond + timeStep) noteDensity++;
			else if (note.millisecond > millisecond + timeStep) break;
		}
		
		if (noteDensity > highestNoteDensity) highestNoteDensity = noteDensity;
	}
	
	highestNoteDensity /= math.min(timeStep, length);
	highestNoteDensity *= 1000;
	
	const averageNoteDensity = chart.notes.size() / (length / 1000);
	highestNoteDensity = math.max(highestNoteDensity, averageNoteDensity);
	
	// i mean it works i guess...
	const difficultyNumber = (5 / 2) * (
		(
			((10 / chart.difficulty.maxHealth) ** (2 / 5)) *
			((chart.difficulty.overallDifficulty / 4) ** (8 / 5)) *
			((1 + (highestNoteDensity / 6)) ** (2 / 5))
		) ** (((8 * averageNoteDensity) / highestNoteDensity) ** (1 / 8))
	);
	
	// const difficultyNumber = 3 * (
	// 	(
	// 		(10 / chart.difficulty.maxHealth) ** (1 / 2) *
	// 		(chart.difficulty.overallDifficulty / 4) ** (2 / 3) *
	// 		(1 + highestNoteDensity / 8) ** (1 / 3)
	// 	) ** (1 + averageNoteDensity / (35 * highestNoteDensity))
	// );
	
	let difficultyWord: string;
	
	const clampedDifficulty = math.clamp(difficultyNumber, 0, 150);
	
	const hue = ((120 - 300 * math.sqrt(math.min(1, clampedDifficulty / 50))) / 360) % 1;
	const saturation = 0.4;
	const value = 0.9 - 0.9 * math.clamp((clampedDifficulty - 50) / 100, 0, 1) ** 1.2;
	
	const difficultyColor = Color3.fromHSV(hue, saturation, value);
	
	if (difficultyNumber >= 100) {
		difficultyWord = 'Impossible';
	} else if (difficultyNumber >= 80) {
		difficultyWord = 'Extreme+';
	} else if (difficultyNumber >= 60) {
		difficultyWord = 'Extreme';
	} else if (difficultyNumber >= 40) {
		difficultyWord = 'Crazy+';
	} else if (difficultyNumber >= 20) {
		difficultyWord = 'Crazy';
	} else if (difficultyNumber >= 15) {
		difficultyWord = 'Expert+';
	} else if (difficultyNumber >= 12.5) {
		difficultyWord = 'Expert';
	} else if (difficultyNumber >= 10) {
		difficultyWord = 'Insane';
	} else if (difficultyNumber >= 5) {
		difficultyWord = 'Hard';
	} else if (difficultyNumber >= 2.5) {
		difficultyWord = 'Normal';
	} else {
		difficultyWord = 'Easy';
	}
	
	return $tuple(difficultyNumber, difficultyWord, difficultyColor);
}

export function calculateTokensReward(difficultyNumber: number, accuracy: number, songDuration: number) {
	let tokens = 300 * (math.clamp(difficultyNumber, 0, 50) / 10)
						* ((math.clamp(accuracy, 0, 100) / 100) ** 1.5)
						* ((math.max(songDuration, 10_000) / 90_000) ** 0.5);
	
	if (tokens > 3_000) tokens = 3_000 + math.sqrt(tokens - 3_000);
	
	return math.max(tokens, 50);
}

export function calculateActualNoteSpeed(noteSpeed: number, bpm: number, scrollSpeed: number): number {
	const bps = bpm / 60;
	const totalScrollSpeed = scrollSpeed * noteSpeed;
	const pixelsPerSecond = totalScrollSpeed * bps;
	return pixelsPerSecond * 25;
}

export function updateHUD(comboChanged: boolean, accuracyChanged: boolean): void {
	if (comboChanged) {
		screenGui.ComboCounter.Combo.Text = string.format(comboFormat, noteCombo);
		screenGui.ComboCounter.Combo.UIScale.Scale = 1.2;
		
		const comboInfoScale = new TweenInfo(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
		TweenService.Create(screenGui.ComboCounter.Combo.UIScale, comboInfoScale, { Scale: 1 }).Play();
	}
	
	if (accuracyChanged) {
		screenGui.AccuracyDisplay.GroupTransparency = 0;
		screenGui.AccuracyDisplay.Accuracy.UIScale.Scale = 1.2;
		
		const accuracyInfoScale = new TweenInfo(1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
		const accuracyInfoTransparency = new TweenInfo(2, Enum.EasingStyle.Linear);
		TweenService.Create(screenGui.AccuracyDisplay.Accuracy.UIScale, accuracyInfoScale, { Scale: 1 }).Play();
		TweenService.Create(screenGui.AccuracyDisplay, accuracyInfoTransparency, { GroupTransparency: 1 }).Play();
	}
	
	if (noteCombo > highestCombo) highestCombo = noteCombo;
	
	const accuracy = string.format('%.3f', calculateAccuracy(notesMax, notes300, notes200, notes100, notes50, notesMisses));
	screenGui.InfoHUD.Score.Text = `<stroke thickness="1" color="#000" joins="miter">Score: <b>${Utils.formatNumber(totalScore)}</b></stroke>`;
	screenGui.InfoHUD.Accuracy.Text = `<stroke thickness="1" color="#000" joins="miter">Accuracy: <b>${accuracy}%</b></stroke>`;
	screenGui.InfoHUD.Combo.Text = `<stroke thickness="1" color="#000" joins="miter">Combo: <b>${Utils.formatNumber(noteCombo)}x</b></stroke>`;
	screenGui.InfoHUD.Misses.Text = `<stroke thickness="1" color="#000" joins="miter">Misses: <b>${Utils.formatNumber(notesMisses)}</b></stroke>`;
}

export function calculateYPosition(elapsedTime: number, noteData: Types.NoteObject, noteSpeed: number, bpm: number, scrollSpeed: number, laneHeight: number, hitPosition: number, heldTimings: Types.TimingObject[], distanceTravelled=0, heldTimeIndex=0): number {
	const movementHeight = laneHeight * (hitPosition / 480);
	
	const noteRemainingTime = noteData.millisecond - elapsedTime;
	const currentSpeed = calculateActualNoteSpeed(noteSpeed, bpm, scrollSpeed) / 1000;
	
	const remainingPointTime = heldTimeIndex < heldTimings.size() ? heldTimings[heldTimeIndex].millisecond - elapsedTime : math.huge;
	if (noteRemainingTime < remainingPointTime) {
		distanceTravelled += noteRemainingTime * currentSpeed;
		return movementHeight - distanceTravelled;
	}
	
	distanceTravelled += remainingPointTime * currentSpeed;
	
	if (distanceTravelled > movementHeight) {
		return movementHeight - distanceTravelled;
	}
	
	const removedTiming = heldTimings[heldTimeIndex];
	
	return calculateYPosition(elapsedTime + remainingPointTime, noteData, noteSpeed, removedTiming.bpm ?? bpm, removedTiming.scrollSpeed ?? scrollSpeed, laneHeight, hitPosition, heldTimings, distanceTravelled, heldTimeIndex + 1);
}

function averageAllNumbers(list: number[]) {
	if (list.size() === 0) return 0;
	
	let total = 0;
	for (const number of list) total += number;
	
	return total / list.size();
}

export function hitNote(hitOffset: number, j: number, note: Types.UINote, noteObject: Types.CreatedNote, createdNotes: Types.CreatedNote[]): void {
	if ((noteObject.isHoldNote && noteObject.isReleased) || (noteObject.isTailNote && noteObject.holdNote?.isReleased)) return;
	
	if (hitOffset > 0) allHitErrors[0].push(hitOffset);
	else allHitErrors[1].push(hitOffset);
	
	averageError[0] = averageAllNumbers(allHitErrors[0]);
	averageError[1] = averageAllNumbers(allHitErrors[1]);
	
	const hitPercentage = hitOffset > 0 ? hitOffset / maxAccuracy : hitOffset / minAccuracy;
	
	noteCombo++;
	
	let scoreBoost = 0;
	
	if (hitPercentage < 0.125) {
		scoreBoost = 300;
		notesMax++;
		
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Marvelous!!');
	} else if (hitPercentage < 0.3) {
		scoreBoost = 300;
		notes300++;
		
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Perfect!');
	} else if (hitPercentage < 0.6) {
		scoreBoost = 200;
		notes200++;
		
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Great');
	} else if (hitPercentage < 0.7) {
		scoreBoost = 100;
		notes100++;
		
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Ok');
	} else if (hitPercentage < 0.85) {
		scoreBoost = 50;
		notes50++;
		
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Bad');
	} else {
		scoreBoost = 0;
		noteCombo = 0;
		notesMisses++;
		
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Miss');
	}
	
	totalScore += scoreBoost;
	
	updateHUD(true, true);
	
	noteObject.didPress = true;
	createdNotes.remove(j - 1);
	
	if (noteObject.isTailNote && noteObject.holdNote !== undefined) {
		note.Parent?.Destroy();
		
		const holdIndex = createdNotes.indexOf(noteObject.holdNote);
		if (holdIndex >= 0) createdNotes.remove(holdIndex);
	}
	
	note.Destroy();
}

export function laneOnPress(lane: Types.UILane, startTime: number, laneNumber: number, createdNotes: Types.CreatedNote[]) {
	const currentTime = os.clock();
	const elapsedTime = (currentTime - startTime) * 1000;
	
	lane.JudgementLine.Note.BackgroundTransparency = lane.JudgementLine.GetAttribute('PressedTransparency') as number | undefined ?? 0.8;
	
	for (const [j, { note, noteData }] of ipairs(createdNotes)) {
		const noteObject = createdNotes[j - 1];
		if (noteData.lane + 1 !== laneNumber || noteObject.isTailNote) continue;
		
		const hitOffset = noteData.millisecond - elapsedTime;
		if (hitOffset > minAccuracy && hitOffset < maxAccuracy) {
			if (noteObject.isHoldNote) {
				heldLanes.set(laneNumber, noteObject);
				noteObject.isHeld = true;
				noteCombo++;
				updateHUD(true, false);
			} else {
				hitNote(hitOffset, j, note, noteObject, createdNotes);
			}
			
			break;
		}
	}
	
	const sound = (ReplicatedStorage.WaitForChild('normal-hitnormal') as Sound).Clone();
	sound.Parent = Workspace;
	sound.Destroy();
}

export function laneOnRelease(lane: Types.UILane, laneNumber: number, startTime: number, createdNotes: Types.CreatedNote[]): void {
	const elapsedTime = (os.clock() - startTime) * 1000;
	
	lane.JudgementLine.Note.BackgroundTransparency = lane.JudgementLine.GetAttribute('NormalTransparency') as number | undefined ?? 1;
	
	const holdNote = heldLanes.get(laneNumber);
	if (holdNote === undefined || holdNote.isReleased) return;
	
	if (holdNote.tailNote !== undefined) {
		const hitOffset = holdNote.tailNote.noteData.millisecond - elapsedTime;
		if (hitOffset > minAccuracy && hitOffset < maxAccuracy) {
			hitNote(hitOffset, createdNotes.indexOf(holdNote.tailNote), holdNote.tailNote.note, holdNote.tailNote, createdNotes);
			
			holdNote.didPress = true;
			holdNote.tailNote.didPress = true;
		} else {
			holdNote.isHeld = false;
			heldLanes.delete(laneNumber);
			
			noteCombo = 0;
			notesMisses++;
			
			screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Miss');
			
			updateHUD(true, true);
		}
	}
	
	holdNote.isReleased = true;
}

export function parseSubKeyName(name: string, keyCount: number) {
	const operators = ['&', '>', ','];
	
	const tokens: string[] = [];
	let number = '';
	
	for (const character of name.split('')) {
		if (operators.includes(character)) {
			if (number.size() > 0) {
				tokens.push(number);
				number = '';
			}
			
			if (character !== ',') tokens.push(character);
		} else number += character;
	}
	
	if (number.size() > 0) tokens.push(number);
	
	const includedLanes: number[] = [];
	
	for (const i of $range(2, tokens.size(), 3)) {
		const operator = tokens[i - 1];
		let leftNumber = tonumber(tokens[i - 2]);
		let rightNumber = tonumber(tokens[i]);
		
		if (tokens.includes(operator) && leftNumber !== undefined && rightNumber !== undefined) {
			if (leftNumber < 0) leftNumber += keyCount + 1;
			if (rightNumber < 0) rightNumber += keyCount + 1;
			
			if (operator === '&') {
				includedLanes.push(leftNumber, rightNumber);
			} else if (operator === '>') {
				for (const i of $range(leftNumber, rightNumber)) includedLanes.push(i);
			}
		}
	}
	
	for (const [i, lane] of ipairs(includedLanes)) if (lane < 0 || includedLanes.includes(lane, i)) includedLanes.remove(i);
	
	return includedLanes;
}

export function start(chart: Types.Chart, songFolder: Folder, stage: Types.StageModel, debugMode: boolean, autoplay: boolean) {
	return new Promise<Types.RoundStats>((resolve) => {
		if (isPlaying) finish();
		isPlaying = true;
		
		$print('Initializing gameplay...');
		
		Topbar.disableMenu();
		
		let selectedSkinFolder = skinsFolder.WaitForChild(selectedNoteSkin, 5) as Types.SkinFolder | undefined;
		if (!selectedSkinFolder) selectedSkinFolder = skinsFolder.WaitForChild('Circles V1') as Types.SkinFolder;
		
		laneTemplates.clear();
		
		for (const subKeyFolder of selectedSkinFolder.GetChildren()) {
			if (!subKeyFolder.IsA('Folder')) continue;
			
			try {
				const lanes = parseSubKeyName(subKeyFolder.Name, chart.metadata.totalLanes);
				
				for (const lane of lanes) {
					laneTemplates[lane - 1] = {
						Lane: subKeyFolder.FindFirstChild('Lane') as Types.UILane,
						Note: subKeyFolder.FindFirstChild('Note') as Types.UINote,
						HoldNote: subKeyFolder.FindFirstChild('HoldNote') as Types.UIHoldNote,
						TailNote: subKeyFolder.FindFirstChild('TailNote') as Types.UITailNote,
						BodyNote: subKeyFolder.FindFirstChild('BodyNote') as Types.UIBodyNote,
					};
				}
			} catch (err) {
				$warn(`Error while parsing sub key folder '${subKeyFolder}' - ${err}`);
			}
		}
		
		for (const i of $range(1, chart.metadata.totalLanes)) {
			if (laneTemplates[i - 1] === undefined) {
				laneTemplates[i - 1] = {
					Lane: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('Lane') as Types.UILane,
					Note: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('Note') as Types.UINote,
					HoldNote: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('HoldNote') as Types.UIHoldNote,
					TailNote: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('TailNote') as Types.UITailNote,
					BodyNote: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('BodyNote') as Types.UIBodyNote,
				};
			}
		}
		
		for (const hotkey of laneHotkeys) hotkey.destroy();
		laneHotkeys.clear();
		heldLanes.clear();
		
		for (const frame of laneFrames) frame.Destroy();
		laneFrames.clear();
		
		const totalLanes = chart.metadata.totalLanes;
		
		screenGui.Transition.Size = new UDim2(0, 0, 1, 0);
		screenGui.Transition.Position = new UDim2(0, 0, 0, 0);
		screenGui.Transition.AnchorPoint = new Vector2(0, 0);
		
		TweenService.Create(screenGui.Transition, new TweenInfo(1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
			Size: new UDim2(1, 0, 1, 0),
		}).Play();
		
		task.wait(1);
		
		$print('Finished transition');
		
		averageError[0] = 0;
		averageError[1] = 0;
		allHitErrors[0].clear();
		allHitErrors[1].clear();
		
		hitPositions.clear();
		
		totalScore = 0;
		maxScore = chart.notes.size() * 300;
		
		notesMax = 0; // Marvelous
		notes300 = 0; // Perfect
		notes200 = 0; // Good
		notes100 = 0; // Ok
		notes50 = 0; // Meh
		notesMisses = 0;
		noteCombo = 0;
		highestCombo = 0;
		bpm = 60;
		scrollSpeed = 1;
		endTime = 0;
		
		startTime = os.clock() + 4;
		countdown = 3;
		
		heldNotes.clear();
		heldTimings.clear();
		heldEvents.clear();
		createdNotes.clear();
		createdNoteId = 0;
		
		loadStartTime = os.clock();
		lastPreviewUpdateTime = os.clock();
		
		stageModel = stage;
		
		useAutoplay = autoplay;
		useDebugMode = debugMode;
		
		if (useDebugMode) screenGui.DebugHUD.Visible = true;
		
		screenGui.ComboCounter.Combo.Text = string.format(comboFormat, 0);
		screenGui.ComboCounter.Visible = true;
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, '');
		screenGui.AccuracyDisplay.Visible = true;
		screenGui.InfoHUD.Visible = true;
		
		screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, '3');
		updateHUD(true, true);
		
		for (const i of $range(1, totalLanes)) {
			hitPositions.push(defaultHitPosition);
			
			const lane = laneTemplates[i - 1].Lane.Clone();
			lane.Name = tostring(i);
			lane.ZIndex = i;
			lane.Size = new UDim2(0, laneWidth, 1, 0);
			lane.Position = new UDim2(0, (camera.ViewportSize.X / 2) - laneWidth * (totalLanes / 2 - i + 1), 0, 0);
			lane.UIPadding.PaddingLeft = new UDim(0, lanePadding);
			lane.UIPadding.PaddingRight = new UDim(0, lanePadding);
			lane.JudgementLine.Position = new UDim2(0.5, 0, defaultHitPosition / 480, 0);
			lane.Parent = screenGui.Lanes;
			
			laneFrames.push(lane);
			
			const hotkey = new UserInput.Hotkey(`Lane${i}`, bindedKeys[i - 1]);
			
			hotkey.onPress(() => laneOnPress(lane, startTime, i, createdNotes));
			hotkey.onRelease(() => laneOnRelease(lane, i, startTime, createdNotes));
			
			laneHotkeys.push(hotkey);
		}
		
		screenGui.Lanes.Visible = true;
		
		$print(`Created ${totalLanes} lanes and binded ${laneHotkeys.size()} keys`);
		
		for (const [, timing] of ipairs(chart.timings)) {
			heldTimings.push(timing);
			if (timing.millisecond > endTime) endTime = timing.millisecond;
		}
		
		heldTimings.sort((a, b) => a.millisecond < b.millisecond);
		
		for (const [i, note] of ipairs(chart.notes)) {
			if (note.lane < 0 || note.lane > totalLanes - 1) {
				$warn(`> Note #${i} is not in a valid lane (${note.lane}), the mininum is 0 and the maximum is ${totalLanes - 1}`);
				continue;
			}
			
			const noteEndTime = note.type === 1 ? (note.millisecond + note.holdLength) : note.millisecond;
			if (noteEndTime > endTime) endTime = noteEndTime;
			
			if (note.type === 0) {
				heldNotes.push({
					type: 0,
					millisecond: note.millisecond,
					lane: note.lane
				});
			} else if (note.type === 1) {
				heldNotes.push({
					type: 1,
					millisecond: note.millisecond,
					lane: note.lane,
					holdLength: note.holdLength
				});
			}
		}
		
		heldNotes.sort((a, b) => a.millisecond < b.millisecond);
		
		bpm = heldTimings[0].bpm ?? 60;
		scrollSpeed = heldTimings[0].scrollSpeed ?? 1;
		
		$print(`Loaded ${heldNotes.size()} notes, ${heldTimings.size()} timings, and ${heldEvents.size()} events in ${string.format('%.4f', (os.clock() - loadStartTime) / 1000)}ms`);
		
		music = songFolder.WaitForChild(chart.metadata.audioName) as Sound;
		
		screenGui.Transition.Size = new UDim2(1, 0, 1, 0);
		screenGui.Transition.Position = new UDim2(1, 0, 0, 0);
		screenGui.Transition.AnchorPoint = new Vector2(1, 0);
		
		TweenService.Create(screenGui.Transition, new TweenInfo(1, Enum.EasingStyle.Quad, Enum.EasingDirection.In), {
			Size: new UDim2(0, 0, 1, 0),
		}).Play();
		
		originalCameraCFrame = camera.CFrame;
		camera.CameraType = Enum.CameraType.Scriptable;
		camera.CFrame = stage.Camera.CFrame;
		
		task.wait(1);
		
		$print('Finished second transition');
		
		try {
			eventsFolder.UpdateStagePreview.FireServer(Compression.compress(`0,nan,0,0,${bpm},${scrollSpeed}|`));
		} catch (err) {  }
		
		startResolve = resolve;
		isPlaying = true;
		
		$print('Binded main gameplay loop');
	});
}

export function gameUpdate(dt: number) {
	if (music === undefined || stageModel === undefined) return;
	
	for (const hotkey of laneHotkeys) {
		if (useAutoplay || devAutoPlay) hotkey.canPress = false;
	}
	
	const currentTime = os.clock();
	const elapsedTime = math.floor((currentTime - startTime) * 1000);
	
	// scrollSpeed = 1;
	// bpm = 250;
	
	// hitPosition = 480 - (((elapsedTime / 1000) * calculateActualNoteSpeed(noteSpeed, bpm, scrollSpeed) * 2) / camera.ViewportSize.Y * 240) % 240;
	// for (const lane of laneFrames) lane.JudgementLine.Position = new UDim2(0.5, 0, hitPosition / 480, 0);
	
	if (countdown > 0) {
		if (countdown === 3 && elapsedTime >= -2000) {
			countdown = 2;
			
			screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, '2');
			updateHUD(false, true);
		} else if (countdown === 2 && elapsedTime >= -1000) {
			countdown = 1;
			
			screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, '1');
			updateHUD(false, true);
		} else if (countdown === 1 && elapsedTime >= 0) {
			countdown = 0;
		}
	}
	
	if (elapsedTime >= 0) {
		if (elapsedTime >= endTime + 500) {
			isPlaying = false;
			
			if (music.IsPlaying) {
				const previousMusic = music;
				const originalVolume = previousMusic.Volume;
				
				TweenService.Create(previousMusic, new TweenInfo(5, Enum.EasingStyle.Linear), {
					Volume: 0,
				}).Play();
				
				task.delay(5, () => {
					previousMusic.Volume = originalVolume;
					previousMusic.Stop();
				});
			}
			
			task.delay(4, async () => {
				const results = await finish();
				if (startResolve !== undefined) startResolve(results);
				startResolve = undefined;
			});
			
			return;
		} else if (!music.IsPlaying) music.Play();
	}
	
	let totalRemoves = 0;
	
	for (const [, noteData] of ipairs(heldNotes)) {
		if (createdNotes.size() >= maxVisibleNotes) break;
		
		const hitPosition = hitPositions[noteData.lane];
		const laneHeight = laneFrames[noteData.lane].AbsoluteSize.Y;
		const yPosition = calculateYPosition(elapsedTime, noteData, noteSpeed, bpm, scrollSpeed, laneHeight, hitPosition, heldTimings);
		
		if (yPosition >= 0 && yPosition <= laneHeight + laneWidth) {
			totalRemoves++;
			
			const laneContainer = laneFrames[noteData.lane];
			const template = laneTemplates[noteData.lane];
			
			if (noteData.type === 0) {
				const newNote = template.Note.Clone();
				newNote.Position = new UDim2(0, 0, 0, 0);
				newNote.AnchorPoint = new Vector2(0, 1);
				newNote.Parent = laneContainer.Notes;
				
				createdNotes.push({ note: newNote, noteData: noteData, isTailNote: false, isHoldNote: false, didAutoPress: false, didPress: false, id: createdNoteId });
				createdNoteId++;
			} else if (noteData.type === 1) {
				const group = new Instance('CanvasGroup');
				group.Position = new UDim2(0, 0, 0, 0);
				group.Size = new UDim2(1, 0, 1, 0);
				group.BackgroundTransparency = 1;
				
				const holdNote = template.HoldNote.Clone();
				holdNote.Position = new UDim2(0, 0, 0, 0);
				holdNote.AnchorPoint = new Vector2(0, 1);
				holdNote.Parent = group;
				
				const tailNote = template.TailNote.Clone();
				tailNote.Position = new UDim2(0, 0, 0, 0);
				tailNote.AnchorPoint = new Vector2(0, 1);
				tailNote.Parent = group;
				
				const bodyNote = template.BodyNote.Clone();
				bodyNote.Position = new UDim2(0, 0, 0, 0);
				bodyNote.AnchorPoint = new Vector2(0, 0);
				bodyNote.Parent = group;
				
				group.Parent = laneContainer.Notes;
				
				const holdObject: Types.HoldCreatedNote = {
					note: holdNote,
					bodyNote: bodyNote,
					noteData: {
						type: 1,
						holdLength: noteData.holdLength,
						lane: noteData.lane,
						millisecond: noteData.millisecond
					},
					isTailNote: false,
					isHoldNote: true,
					isHeld: false,
					didPress: false,
					didAutoPress: false,
					isReleased: false,
					tailNote: undefined,
					id: createdNoteId,
				};
				
				createdNoteId++;
				
				const tailObject: Types.TailCreatedNote = {
					note: tailNote,
					noteData: {
						type: 1,
						holdLength: noteData.holdLength,
						lane: noteData.lane,
						millisecond: noteData.millisecond + noteData.holdLength
					},
					isTailNote: true,
					isHoldNote: false,
					didAutoPress: false,
					didPress: false,
					holdNote: holdObject,
					id: createdNoteId
				};
				
				createdNoteId++;
				
				holdObject.tailNote = tailObject;
				
				createdNotes.push(holdObject, tailObject);
			}
		} else break;
	}
	
	for (const _ of $range(1, totalRemoves)) heldNotes.remove(0);
	
	const removeIndices: number[] = [];
	
	for (let [i, { noteData, note }] of ipairs(createdNotes)) {
		const noteObject = createdNotes[i - 1];
		const laneHeight = laneFrames[noteData.lane].AbsoluteSize.Y;
		
		if (noteObject.didPress) {
			removeIndices.push(i);
			continue;
		}
		
		const hitPosition = hitPositions[noteData.lane];
		
		const yOffset = calculateYPosition(elapsedTime, noteData, noteSpeed, bpm, scrollSpeed, laneHeight, hitPosition, heldTimings);
		const hitOffset = noteData.millisecond - elapsedTime;
		const hitPercentage = hitOffset > 0 ? hitOffset / maxAccuracy : hitOffset / minAccuracy;
		
		if ((useAutoplay || devAutoPlay) && hitPercentage <= 0.1) {
			const hotkey = laneHotkeys[noteData.lane];
			
			if (noteData.type === 0) {
				hotkey.release();
				hotkey.press();
				hotkey.release();
			} else if (noteData.type === 1) {
				if (noteObject.isHoldNote && !noteObject.didAutoPress) {
					hotkey.release();
					hotkey.press();
					noteObject.didAutoPress = true;
				}
				
				if (noteObject.isTailNote && !noteObject.didAutoPress) {
					hotkey.release();
					noteObject.didAutoPress = true;
				}
			}
		}
		
		if (noteObject.isHoldNote && note.Parent !== undefined) {
			if (noteObject.isReleased) (note.Parent as CanvasGroup).GroupTransparency = 0.5;
			else (note.Parent as CanvasGroup).GroupTransparency = 0;
		}
		
		note.Position = new UDim2(0, 0, 0, yOffset);
		
		if (noteObject.isHoldNote) {
			if (noteObject.isHeld && !noteObject.isReleased) note.Position = new UDim2(0, 0, 0, laneHeight * (hitPosition / 480));
			else {
				if (elapsedTime >= noteData.millisecond + maxAccuracy && !noteObject.isReleased) {
					noteObject.isReleased = true;
					
					noteCombo = 0;
					notesMisses++;
					
					screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Miss');
					
					updateHUD(true, true);
				}
			}
			
			let topOffset = calculateYPosition(elapsedTime, noteObject.tailNote!.noteData, noteSpeed, bpm, scrollSpeed, laneHeight, hitPosition, heldTimings);
			let bottomOffset = note.Position.Y.Offset;
			
			if (typeIs(noteObject.bodyNote.GetAttribute('OffsetTop'), 'number')) {
				topOffset += math.round(laneWidth * (noteObject.bodyNote.GetAttribute('OffsetTop') as number));
			}
			
			if (typeIs(noteObject.bodyNote.GetAttribute('OffsetBottom'), 'number')) {
				bottomOffset += math.round(laneWidth * (noteObject.bodyNote.GetAttribute('OffsetBottom') as number));
			}
			
			noteObject.bodyNote.Position = new UDim2(0, 0, 0, topOffset);
			noteObject.bodyNote.Size = new UDim2(1, 0, 0, bottomOffset - topOffset);
		} else if (noteObject.isTailNote && noteObject.holdNote?.isHeld && yOffset >= laneHeight * (hitPosition / 480)) {
			hitNote(0, i, note, noteObject, createdNotes);
			heldLanes.delete(noteData.lane + 1);
		}
		
		if ((!noteObject.isHoldNote && !noteObject.isTailNote) || (noteObject.isTailNote && noteObject.holdNote?.isReleased)) {
			if (elapsedTime >= noteData.millisecond + maxAccuracy) {
				if (useAutoplay || devAutoPlay) laneHotkeys[noteData.lane].release();
				
				let doMiss = true;
				if (noteObject.isTailNote && noteObject.holdNote !== undefined) {
					if (noteObject.holdNote.isReleased) doMiss = false;
					
					note.Parent?.Destroy();
					
					const holdIndex = createdNotes.indexOf(noteObject.holdNote);
					if (holdIndex >= 0 && !removeIndices.includes(holdIndex)) removeIndices.push(holdIndex + 1);
				}
				
				if (doMiss) {
					noteCombo = 0;
					notesMisses++;
					
					screenGui.AccuracyDisplay.Accuracy.Text = string.format(accuracyFormat, 'Miss');
					
					updateHUD(true, true);
				}
				
				note.Destroy();
				if (!removeIndices.includes(i)) removeIndices.push(i);
			}
		}
	}
	
	removeIndices.sort((a, b) => a > b);
	for (const index of removeIndices) {
		const removedNote = createdNotes.remove(index - 1);
		if (removedNote !== undefined) {
			removedNote.note.Destroy();
			if (removedNote.isHoldNote || removedNote.isTailNote) {
				if (removedNote.isHoldNote) removedNote.bodyNote.Destroy();
				
				removedNote.note.Parent?.Destroy();
			}
		}
	}
	
	for (const [i, timing] of ipairs(heldTimings)) {
		if (elapsedTime >= timing.millisecond) {
			if (timing.type === 0) {
				if (timing.bpm !== undefined) bpm = timing.bpm;
				if (timing.scrollSpeed !== undefined) scrollSpeed = timing.scrollSpeed;
			}
			
			heldTimings.remove(i - 1);
		} else break;
	}
	
	if (os.clock() - lastPreviewUpdateTime > 0.067) {
		const accuracy = calculateAccuracy(notesMax, notes300, notes200, notes100, notes50, notesMisses);
		let previewData = `${totalScore},${math.round(accuracy * 100)},${notesMisses},${noteCombo},${selectedNoteSkin}|`;
		
		for (const note of createdNotes) {
			const laneHeight = laneFrames[note.noteData.lane].AbsoluteSize.Y;
			const position = note.note.Position.Y.Offset;
			
			previewData += `${note.noteData.lane},${math.round((position / laneHeight) * 1000)},${note.isTailNote ? 1 : note.isHoldNote ? 2 : 0},${note.id}|`;
		}
		
		eventsFolder.UpdateStagePreview.FireServer(Compression.compress(previewData));
		
		lastPreviewUpdateTime = os.clock();
	}
	
	for (const [i, note] of ipairs(createdNotes)) {
		const laneHeight = laneFrames[note.noteData.lane].AbsoluteSize.Y;
		const hitPosition = hitPositions[note.noteData.lane];
		
		if (note.noteData.millisecond >= elapsedTime
			&& calculateYPosition(elapsedTime, note.noteData, noteSpeed, bpm, scrollSpeed, laneHeight, hitPosition, heldTimings) >= laneHeight * 1.5
		) {
			note.note.Destroy();
			createdNotes.remove(i - 1);
		}
	}
	
	if (useDebugMode) {
		const pressedNotes: string[] = [];
		for (const hotkey of laneHotkeys) pressedNotes.push(hotkey.isPressed ? '1' : '0');
		
		let minutes = elapsedTime.idiv(60_000);
		let seconds = (elapsedTime / 1_000) % 60;
		let milliseconds = elapsedTime % 1000;
		
		if (elapsedTime < 0) {
			minutes = math.ceil(elapsedTime / 60_000);
			seconds = 60 - seconds;
			milliseconds = 1000 - milliseconds;
			screenGui.DebugHUD.Time.TextColor3 = Color3.fromRGB(255, 255, 0);
		} else screenGui.DebugHUD.Time.TextColor3 = Color3.fromRGB(255, 255, 255);
		
		screenGui.DebugHUD.NoteSpeed.Text = string.format('NoteSpeed: %.1f', noteSpeed);
		screenGui.DebugHUD.ScrollSpeed.Text = string.format('ScrollSpeed: %.3fx', scrollSpeed);
		screenGui.DebugHUD.BPM.Text = string.format('BPM: %.3fBPM', bpm);
		screenGui.DebugHUD.BPM.Text = string.format('BPM: %.3fBPM', bpm);
		screenGui.DebugHUD.PixelsPerSecond.Text = string.format('Pixels/s: %dpx/s', calculateActualNoteSpeed(noteSpeed, bpm, scrollSpeed));
		screenGui.DebugHUD.Time.Text = string.format('Time: %02d:%02d.%03d/%02d:%02d.%03d', minutes, seconds, milliseconds, endTime.idiv(60_000), (endTime / 1_000) % 60, endTime % 1000);
		screenGui.DebugHUD.RenderedNotes.Text = string.format('RenderedNotes: %d', createdNotes.size());
		screenGui.DebugHUD.PressedNotes.Text = `PressedNotes: ${pressedNotes.join(',')}`;
		screenGui.DebugHUD.HitPosition.Text = string.format('HitPosition: %s', hitPositions.join(','));
		screenGui.DebugHUD.AverageError.Text = string.format('AvgHitErr: %dms,%dms', averageError[0], averageError[1]);
		screenGui.DebugHUD.Autoplay.Text = `Autoplay: ${useAutoplay || devAutoPlay}`;
		screenGui.DebugHUD.NoteSkin.Text = `NoteSkin: ${selectedNoteSkin}`;
		screenGui.DebugHUD.FPS.Text = string.format('FPS: %.2f', 1 / dt);
	}
	
	camera.CameraType = Enum.CameraType.Scriptable;
	camera.CFrame = stageModel.Camera.CFrame;
}

export function finish() {
	return new Promise<Types.RoundStats>((resolve) => {
		$print('Finishing gameplay...');
		
		isPlaying = false;
		Topbar.enableMenu();
		
		music = undefined;
		
		const roundStats: Types.RoundStats = [
			maxScore,
			notesMax,
			notes300,
			notes200,
			notes100,
			notes50,
			notesMisses,
			noteCombo,
			highestCombo,
			averageError[0],
			averageError[1],
		];
		
		task.delay(1, () => {
			TweenService.Create(camera, new TweenInfo(2, Enum.EasingStyle.Quad, Enum.EasingDirection.InOut), {
				CFrame: originalCameraCFrame,
			}).Play();
			
			task.delay(2, () => camera.CameraType = Enum.CameraType.Custom);
		});
		
		for (const hotkey of laneHotkeys) hotkey.destroy();
		laneHotkeys.clear();
		
		const info = new TweenInfo(2, Enum.EasingStyle.Quad, Enum.EasingDirection.In);
		
		for (const lane of laneFrames) {
			TweenService.Create(lane, new TweenInfo(Utils.randomFloat(0.5, 2), Enum.EasingStyle.Quad, Enum.EasingDirection.In), {
				Position: lane.Position.add(new UDim2(0, 0, 1, 0)),
				Rotation: math.random(-90, 90),
			}).Play();
		}
		
		Utils.destroyAfter(laneFrames, info.Time);
		
		laneFrames.clear();
		
		$print('Cleared lanes');
		
		TweenService.Create(screenGui.ComboCounter, info, {
			GroupTransparency: 1
		}).Play();
		
		TweenService.Create(screenGui.AccuracyDisplay, info, {
			GroupTransparency: 1
		}).Play();
		
		TweenService.Create(screenGui.InfoHUD, info, {
			Position: screenGui.InfoHUD.Position.add(new UDim2(-1.5, 0, 0, 0)),
		}).Play();
		
		TweenService.Create(screenGui.DebugHUD, info, {
			Position: screenGui.DebugHUD.Position.add(new UDim2(-2, 0, 0, 0)),
		}).Play();
		
		$print('Cleared UI');
		
		task.wait(info.Time);
		
		if (!isPlaying) {
			screenGui.Lanes.Visible = false;
			screenGui.ComboCounter.Visible = false;
			screenGui.AccuracyDisplay.Visible = false;
			screenGui.InfoHUD.Visible = false;
			screenGui.DebugHUD.Visible = false;
		}
		
		resolve(roundStats);
	});
}

export function showGrade(chart: Types.Chart, totalScore: number, notesMax: number, notes300: number, notes200: number, notes100: number, notes50: number, notesMisses: number, noteCombo: number, highestCombo: number, maxError: number, minError: number) {
	const accuracy = calculateAccuracy(notesMax, notes300, notes200, notes100, notes50, notesMisses);
	
	let grade: Types.Grade;
	
	if (accuracy === 100) grade = 'X';
	else if (accuracy >= 95) grade = 'S';
	else if (accuracy >= 90) grade = 'A';
	else if (accuracy >= 80) grade = 'B';
	else if (accuracy >= 70) grade = 'C';
	else grade = 'D';
	
	screenGui.Grade.Icon.Image = Constants.ImageIds.RankImages[grade];
	screenGui.Grade.Position = new UDim2(1.8, 0, 0.5, 0);
	screenGui.Grade.Rotation = 359;
	screenGui.Grade.Visible = true;
	
	let maxScore = 0;
	let maxCombo = 0;
	
	for (const note of chart.notes) {
		maxScore += 300;
		
		if (note.type === 0) maxCombo += 1;
		else if (note.type === 1) maxCombo += 2;
	}
	
	const statsContent = screenGui.StatsContainer.Content;
	
	statsContent.Marvelous.Text = `Marvelous: 0`;
	statsContent.Perfect.Text = `Perfect: 0`;
	statsContent.Great.Text = `Great: 0`;
	statsContent.Ok.Text = `Ok: 0`;
	statsContent.Bad.Text = `Bad: 0`;
	statsContent.Misses.Text = `Misses: 0`;
	statsContent.Accuracy.Text = `Accuracy: 0.000%`;
	statsContent.HitError.Text = `Avg. Hit Error: +0.0ms, -0.0ms`;
	statsContent.HighestCombo.Text = `Highest Combo: 0x / ${Utils.formatNumber(maxCombo)}x`;
	statsContent.TotalScore.Text = `Total Score: 0 / ${Utils.formatNumber(maxScore)}`;
	
	statsContent.Accuracy.SetAttribute('Tooltip', `Full Accuracy: ${accuracy}%`);
	
	screenGui.StatsContainer.Position = new UDim2(-0.99, 0, 0.5, 0);
	screenGui.StatsContainer.Visible = true;
	
	const infoOut = new TweenInfo(1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
	const infoIn = new TweenInfo(1, Enum.EasingStyle.Quad, Enum.EasingDirection.In);
	
	TweenService.Create(screenGui.Grade, infoOut, {
		Position: new UDim2(0.8, 0, 0.5, 0),
		Rotation: 6,
	}).Play();
	
	TweenService.Create(screenGui.StatsContainer, infoOut, {
		Position: new UDim2(0.01, 0, 0.5, 0),
	}).Play();
	
	task.wait(infoOut.Time);
	
	let skipAnimation = false;
	
	const mouseClick = screenGui.StatsContainer.Close.MouseButton1Click.Connect(() => {
		skipAnimation = true;
	});
	
	const value = new Instance('NumberValue');
	value.Value = 0;
	
	function empty(x: number, _=false) {
		return x;
	}
	
	function animateLabel(label: TextLabel, targetValue: number, formatted: boolean, rounded: boolean, formatString: string) {
		if (targetValue === 0) {
			label.Text = string.format(formatString, 0);
			return;
		}
		
		skipAnimation = false;
		
		const info = new TweenInfo(1, Enum.EasingStyle.Exponential, Enum.EasingDirection.Out);
		
		value.Value = 0;
		
		const tween = TweenService.Create(value, info, {
			Value: targetValue,
		});
		
		tween.Play();
		
		const roundFunc = rounded ? math.round : empty;
		const formatFunc = formatted ? Utils.formatNumber : empty;
		
		const startTime = os.clock();
		while (os.clock() - startTime < info.Time) {
			label.Text = string.format(formatString, tostring(formatFunc(roundFunc(value.Value), !rounded)));
			if (skipAnimation) break;
			
			task.wait();
		}
		
		label.Text = string.format(formatString, tostring(formatFunc(roundFunc(targetValue), !rounded)));
		
		tween.Destroy();
		
		if (!skipAnimation) task.wait(0.2);
	}
	
	animateLabel(statsContent.Marvelous, notesMax, true, true, 'Marvelous: %d');
	animateLabel(statsContent.Perfect, notes300, true, true, 'Perfect: %d');
	animateLabel(statsContent.Great, notes300, true, true, 'Great: %d');
	animateLabel(statsContent.Ok, notes300, true, true, 'Ok: %d');
	animateLabel(statsContent.Bad, notes300, true, true, 'Bad: %d');
	animateLabel(statsContent.Misses, notes300, true, true, 'Misses: %d');
	animateLabel(statsContent.Accuracy, accuracy, false, false, 'Accuracy: %.3f%%');
	animateLabel(statsContent.HitError, maxError, false, false, 'Avg. Hit Error: +%.1fms, -0.0ms');
	animateLabel(statsContent.HitError, minError, false, false, `Avg. Hit Error: +${string.format('%.1f', maxError)}ms, -%.1fms`);
	animateLabel(statsContent.HighestCombo, highestCombo, true, true, `Highest Combo: %sx / ${Utils.formatNumber(maxCombo)}`);
	animateLabel(statsContent.TotalScore, totalScore, true, true, `Total Score: %s / ${Utils.formatNumber(maxScore)}`);
	
	mouseClick.Disconnect();
	
	screenGui.StatsContainer.Close.MouseButton1Click.Wait();
	
	TweenService.Create(screenGui.Grade, infoIn, {
		Position: new UDim2(1.8, 0, 0.5, 0),
		Rotation: 359,
	}).Play();
	
	TweenService.Create(screenGui.StatsContainer, infoIn, {
		Position: new UDim2(-0.99, 0, 0.5, 0),
	}).Play();
}

export function loadSongModule(module: ModuleScript) {
	return (require(module) as { default: Types.Chart }).default;
}

export function startSongSelection() {
	return new Promise<ModuleScript | '<None>' | '<Exit>'>((resolve) => {
		const songSelector = screenGui.SongSelector;
		if (!songSelector) return resolve('<None>');
		
		screenGui.SongSelector.Position = new UDim2(-0.5, 0, 0.5, 0);
		screenGui.SongSelector.Rotation = 180;
		screenGui.SongSelector.Visible = true;
		
		const info = new TweenInfo(1.5, Enum.EasingStyle.Elastic, Enum.EasingDirection.Out);
		
		TweenService.Create(screenGui.SongSelector, info, {
			Position: new UDim2(0.5, 0, 0.5, 0),
			Rotation: 0,
		}).Play();
		
		let selectedDifficulty: ModuleScript | undefined = undefined;
		
		const connections: RBXScriptConnection[] = [];
		
		Topbar.disableMenu();
		
		connections.push(screenGui.SongSelector.Topbar.Close.MouseButton1Click.Once(() => {
			for (const connection of connections) connection.Disconnect();
			
			resolve('<Exit>');
		}));
		
		connections.push(screenGui.SongSelector.Bottom.Skip.MouseButton1Click.Once(() => {
			for (const connection of connections) connection.Disconnect();
			
			resolve('<None>');
		}));
		
		connections.push(screenGui.SongSelector.Bottom.Select.MouseButton1Click.Once(() => {
			if (selectedDifficulty !== undefined) {
				for (const connection of connections) connection.Disconnect();
				
				endSongSelection(selectedDifficulty, resolve);
			}
		}));
		
		function doSelection<T extends Instance>(container: ScrollingFrame, list: Instance, itemType: keyof Instances, template: TextButton, orderByAttribute: boolean, callback: (item: T) => void) {
			for (const item of container.GetChildren()) {
				if (item.IsA('TextButton')) item.Destroy();
			}
			
			const defaultColor = Color3.fromRGB(255, 255, 255);
			
			if (list.GetAttribute('Category_ShowAll')) {
				for (const category of songsFolder.GetChildren()) {
					for (const item of category.GetChildren()) {
						if (!item.IsA(itemType)) continue;
						
						const button = template.Clone();
						button.Text = tostring(item.GetAttribute('Display') ?? item.Name);
						if (orderByAttribute) button.Name = `Item${item.GetAttribute('Order') ?? 0}`;
						else button.Name = item.Name;
						
						button.TextSize = tonumber(Settings.LocalSettings.get(`TextSize${button.GetAttribute('TextSize')}` as keyof Types.PlayerSettings)) ?? button.TextSize;
						
						button.BackgroundColor3 = (category.GetAttribute('DefaultColor') as Color3 | undefined)
							?? (item.GetAttribute('ItemColor') as Color3 | undefined)
							?? defaultColor;
						
						button.Parent = container;
						
						button.MouseButton1Click.Connect(() => callback(item as any as T));
					}
				}
			} else {
				for (const item of list.GetChildren()) {
					if (!item.IsA(itemType)) continue;
					
					const button = template.Clone();
					button.Text = tostring(item.GetAttribute('Display') ?? item.Name);
					if (orderByAttribute) button.Name = `Item${item.GetAttribute('Order') ?? 0}`;
					else button.Name = item.Name;
					
					button.TextSize = tonumber(Settings.LocalSettings.get(`TextSize${button.GetAttribute('TextSize')}` as keyof Types.PlayerSettings)) ?? button.TextSize;
					
					button.BackgroundColor3 = (list.GetAttribute('DefaultColor') as Color3 | undefined)
						?? (item.GetAttribute('ItemColor') as Color3 | undefined)
						?? defaultColor;
					
					button.Parent = container;
					
					button.MouseButton1Click.Connect(() => callback(item as any as T));
				}
			}
		}
		
		function updateInfoFrame(data: Types.InfoUpdateData) {
			const { isSelected, songTitle, chart } = data;
			
			const infoFrame = screenGui.SongSelector.Content.Info;
			infoFrame.SongTitle.Text = songTitle ?? '--';
			
			if (isSelected) {
				let maxCombo = 0;
				let length = 0;
				
				for (const note of chart.notes) {
					const noteEndTime = note.type === 1 ? (note.millisecond + note.holdLength) : note.millisecond;
					if (noteEndTime > length) length = noteEndTime;
					
					maxCombo += note.type === 1 ? 2 : 1;
				}
				
				const minutes = length.idiv(60_000);
				const seconds = (length / 1_000) % 60;
				
				const [difficultyNumber, difficultyWord, difficultyColor] = calculateDifficulty(chart);
				const hexColor = difficultyColor.ToHex();
				
				infoFrame.Composer.Text = `Composer: <b>${chart.metadata.artist}</b>`;
				infoFrame.Mappers.Text = `Mappers: <b>${chart.metadata.mappers.join(', ')}</b>`;
				infoFrame.StarDifficulty.Text = `DIF: <b><font color="#${hexColor}">${difficultyWord}</font> (@${string.format('%.1f', difficultyNumber)})</b>`;
				infoFrame.MaxHealth.Text = `HP: <b>${chart.difficulty.maxHealth}</b>`;
				infoFrame.OverallDifficulty.Text = `OD: <b>${chart.difficulty.overallDifficulty}</b>`;
				infoFrame.Duration.Text = `DUR: <b>${string.format('%d:%02d', minutes, seconds)}</b>`;
				infoFrame.MaxCombo.Text = `MC: <b>${Utils.formatNumber(maxCombo)}x</b>`;
				infoFrame.KeyCount.Text = `KEYS: <b>${chart.metadata.totalLanes}K</b>`;
				
				infoFrame.StarDifficulty.SetAttribute('Tooltip', `Difficulty (@${difficultyNumber})`);
				infoFrame.MaxHealth.SetAttribute('Tooltip', 'Max Health Points');
				infoFrame.OverallDifficulty.SetAttribute('Tooltip', 'Overall Difficulty');
				infoFrame.Duration.SetAttribute('Tooltip', `Duration/Length (${length / 1_000} seconds)`);
				infoFrame.MaxCombo.SetAttribute('Tooltip', 'Maximum Combo');
				infoFrame.KeyCount.SetAttribute('Tooltip', '# of Keys/Lanes');
				
				screenGui.SongSelector.Bottom.Select.AutoButtonColor = true;
				screenGui.SongSelector.Bottom.Select.BackgroundColor3 = Color3.fromRGB(57, 230, 92);
			} else {
				infoFrame.Composer.Text = songTitle ? '<i>Select a difficulty</i>' : '<i>Select a song</i>';
				infoFrame.Mappers.Text = '';
				infoFrame.StarDifficulty.Text = '';
				infoFrame.MaxHealth.Text = '';
				infoFrame.OverallDifficulty.Text = '';
				infoFrame.Duration.Text = '';
				infoFrame.MaxCombo.Text = '';
				infoFrame.KeyCount.Text = '';
				
				infoFrame.StarDifficulty.SetAttribute('Tooltip', undefined);
				infoFrame.MaxHealth.SetAttribute('Tooltip', undefined);
				infoFrame.OverallDifficulty.SetAttribute('Tooltip', undefined);
				infoFrame.Duration.SetAttribute('Tooltip', undefined);
				infoFrame.MaxCombo.SetAttribute('Tooltip', undefined);
				infoFrame.KeyCount.SetAttribute('Tooltip', undefined);
				
				screenGui.SongSelector.Bottom.Select.AutoButtonColor = false;
				screenGui.SongSelector.Bottom.Select.BackgroundColor3 = Color3.fromRGB(102, 179, 117);
			}
		}
		
		updateInfoFrame({
			isSelected: false,
			chart: undefined,
		});
		
		doSelection<TextButton>(screenGui.SongSelector.Content.Categories, songsFolder, 'Folder', categoryButtonTemplate, false, (category) => {
			doSelection<TextButton>(screenGui.SongSelector.Content.Songs, category, 'Folder', songButtonTemplate, false, (song) => {
				selectedDifficulty = undefined;
				
				updateInfoFrame({
					isSelected: false,
					songTitle: song.Name,
					chart: undefined,
				});
				
				doSelection<ModuleScript>(screenGui.SongSelector.Content.Info.Difficulties, song, 'ModuleScript', difficultyButtonTemplate, false, (difficulty) => {
					selectedDifficulty = difficulty;
					
					const chart = loadSongModule(difficulty);
					
					updateInfoFrame({
						isSelected: true,
						songTitle: song.Name,
						chart: chart,
					});
				});
			});
		});
	});
}

export function endSongSelection(difficulty?: ModuleScript, resolve?: (difficulty: ModuleScript) => void) {
	for (const categoryButton of screenGui.SongSelector.Content.Categories.GetChildren()) {
		if (categoryButton.IsA('TextButton')) categoryButton.Destroy();
	}
	
	for (const songButton of screenGui.SongSelector.Content.Songs.GetChildren()) {
		if (songButton.IsA('TextButton')) songButton.Destroy();
	}
	
	for (const difficultyButton of screenGui.SongSelector.Content.Info.Difficulties.GetChildren()) {
		if (difficultyButton.IsA('TextButton')) difficultyButton.Destroy();
	}
	
	const info = new TweenInfo(1, Enum.EasingStyle.Back, Enum.EasingDirection.In);
	
	screenGui.SongSelector.Position = new UDim2(0.5, 0, 0.5, 0);
	
	TweenService.Create(screenGui.SongSelector, info, {
		Position: new UDim2(1.5, 0, 0.5, 0),
		Rotation: 180,
	}).Play();
	
	Topbar.enableMenu();
	
	if (difficulty !== undefined && resolve !== undefined) resolve(difficulty as ModuleScript);
}

export function updatePreview(preview: Types.StagePreview, songFolder: Folder, updateData: string, chart: Types.Chart) {
	const sections = updateData.split('|');
	
	const data = sections[0];
	
	const [stringTotalScore, stringAccuracy, stringNotesMisses, stringNoteCombo, noteSkin] = data.split(',');
	
	const totalNotes = chart.notes.size();
	const maxScore = totalNotes * 300;
	
	const totalScore = math.clamp(tonumber(stringTotalScore) ?? 0, 0, maxScore);
	const accuracy = string.format('%.3f', math.clamp((tonumber(stringAccuracy) ?? tonumber('nan') as number) / 100, 0, 100));
	const notesMisses = math.clamp(tonumber(stringNotesMisses) ?? 0, 0, totalNotes);
	const noteCombo = math.clamp(tonumber(stringNoteCombo) ?? 0, 0, totalNotes);
	
	let selectedSkinFolder = skinsFolder.FindFirstChild(noteSkin) as Types.SkinFolder | undefined;
	if (!selectedSkinFolder) return;
	
	preview.SurfaceGui.InfoHUD.Score.Text = `<stroke thickness="1" color="#000" joins="miter">Score: <b>${Utils.formatNumber(totalScore)}</b></stroke>`;
	preview.SurfaceGui.InfoHUD.Accuracy.Text = `<stroke thickness="1" color="#000" joins="miter">Accuracy: <b>${accuracy}%</b></stroke>`;
	preview.SurfaceGui.InfoHUD.Combo.Text = `<stroke thickness="1" color="#000" joins="miter">Combo: <b>${Utils.formatNumber(noteCombo)}x</b></stroke>`;
	preview.SurfaceGui.InfoHUD.Misses.Text = `<stroke thickness="1" color="#000" joins="miter">Misses: <b>${Utils.formatNumber(notesMisses)}</b></stroke>`;
	
	const laneTemplates: { Note: Types.UINote, HoldNote: Types.UIBodyNote, TailNote: Types.UITailNote, BodyNote: Types.UIBodyNote, Lane: Types.UILane }[] = [];
		
	for (const subKeyFolder of selectedSkinFolder.GetChildren()) {
		if (!subKeyFolder.IsA('Folder')) continue;
		
		try {
			const lanes = parseSubKeyName(subKeyFolder.Name, chart.metadata.totalLanes);
			
			for (const lane of lanes) {
				laneTemplates[lane - 1] = {
					Lane: subKeyFolder.FindFirstChild('Lane') as Types.UILane,
					Note: subKeyFolder.FindFirstChild('Note') as Types.UINote,
					HoldNote: subKeyFolder.FindFirstChild('HoldNote') as Types.UIHoldNote,
					TailNote: subKeyFolder.FindFirstChild('TailNote') as Types.UITailNote,
					BodyNote: subKeyFolder.FindFirstChild('BodyNote') as Types.UIBodyNote,
				};
			}
		} catch (err) {  }
	}
	
	for (const i of $range(1, chart.metadata.totalLanes)) {
		if (laneTemplates[i - 1] === undefined) {
			laneTemplates[i - 1] = {
				Lane: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('Lane') as Types.UILane,
				Note: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('Note') as Types.UINote,
				HoldNote: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('HoldNote') as Types.UIHoldNote,
				TailNote: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('TailNote') as Types.UITailNote,
				BodyNote: skinsFolder.FindFirstChild('CirclesV1')!.FindFirstChild('1>-3,-1&-1')!.FindFirstChild('BodyNote') as Types.UIBodyNote,
			};
		}
	}
	
	const totalLanes = chart.metadata.totalLanes;
	
	const laneFrames = preview.SurfaceGui.Lanes.GetChildren() as Types.UILane[];
	const usedArrows = new Set<Types.UINote>();
	
	const laneHolds = new Map<number, number>();
	
	const info = new TweenInfo(0.067, Enum.EasingStyle.Linear, Enum.EasingDirection.In);
	
	for (const i of $range(1, chart.metadata.totalLanes)) {
		if (!preview.SurfaceGui.Lanes.FindFirstChild(tostring(i))) {
			const lane = laneTemplates[i - 1].Lane.Clone();
			lane.Name = tostring(i);
			lane.ZIndex = i;
			lane.Size = new UDim2(0, laneWidth, 1, 0);
			lane.Position = new UDim2(0, (preview.SurfaceGui.AbsoluteSize.X / 2) - laneWidth * (totalLanes / 2 - i + 1), 0, 0);
			lane.UIPadding.PaddingLeft = new UDim(0, lanePadding);
			lane.UIPadding.PaddingRight = new UDim(0, lanePadding);
			lane.JudgementLine.Position = new UDim2(0.5, 0, defaultHitPosition / 480, 0);
			lane.Parent = preview.SurfaceGui.Lanes;
			
			laneFrames.push(lane);
		}
	}
	
	for (const i of $range(1, sections.size() - 2)) {
		let [lane, yScale, noteType, id] = sections[i].split(',').map((value) => tonumber(value) ?? 0);
		
		if (lane < 0 || lane >= chart.metadata.totalLanes) continue;
		
		yScale /= 1000;
		
		const laneContainer = laneFrames[lane];
		if (!laneContainer) return;
		
		const template = laneTemplates[lane];
		
		if (noteType === 0) {
			let note = laneContainer.Notes.FindFirstChild(tostring(id)) as Types.UINote | undefined;
			if (!note) {
				note = template.Note.Clone();
				note.Name = tostring(id);
				note.Position = new UDim2(0, 0, yScale, 0);
				note.AnchorPoint = new Vector2(0, 1);
				note.Parent = laneContainer.Notes;
			} else TweenService.Create(note, info, { Position: new UDim2(0, 0, yScale, 0) }).Play();
			
			usedArrows.add(note);
		} else if (noteType === 1) {
			let tailNote = laneContainer.Notes.FindFirstChild(tostring(id)) as Types.UITailNote | undefined;
			if (!tailNote) {
				tailNote = template.TailNote.Clone();
				tailNote.Name = tostring(id);
				tailNote.Position = new UDim2(0, 0, 0, 0);
				tailNote.AnchorPoint = new Vector2(0, 1);
				tailNote.Parent = laneContainer.Notes;
			}
			
			TweenService.Create(tailNote, info, {
				Position: new UDim2(0, 0, yScale, 0),
			}).Play();
			
			usedArrows.add(tailNote);
			
			const holdYScale = laneHolds.get(lane);
			if (holdYScale) {
				let topOffset = 0;
				let bottomOffset = laneWidth.idiv(-2);
				
				if (typeIs(template.BodyNote.GetAttribute('OffsetTop'), 'number')) {
					topOffset += laneWidth * (template.BodyNote.GetAttribute('OffsetTop') as number);
				}
				
				if (typeIs(template.BodyNote.GetAttribute('OffsetBottom'), 'number')) {
					bottomOffset -= laneWidth * (template.BodyNote.GetAttribute('OffsetBottom') as number);
				}
				
				let bodyNote = laneContainer.Notes.FindFirstChild(tostring(id + 0.5)) as Types.UIBodyNote | undefined;
				if (!bodyNote) {
					bodyNote = template.BodyNote.Clone();
					bodyNote.Name = tostring(id + 0.5);
					bodyNote.Position = new UDim2(0, 0, 0, 0);
					bodyNote.Size = new UDim2(1, 0, 0, 0);
					bodyNote.AnchorPoint = new Vector2(0, 0);
					bodyNote.Parent = laneContainer.Notes;
				}
				
				TweenService.Create(bodyNote, info, {
					Position: new UDim2(0, 0, yScale, topOffset),
					Size: new UDim2(1, 0, holdYScale - yScale, bottomOffset),
				}).Play();
				
				laneHolds.delete(lane);
				usedArrows.add(bodyNote);
			}
		} else if (noteType === 2) {
			let holdNote = laneContainer.Notes.FindFirstChild(tostring(id)) as Types.UIHoldNote | undefined;
			if (!holdNote) {
				holdNote = template.HoldNote.Clone();
				holdNote.Name = tostring(id);
				holdNote.Position = new UDim2(0, 0, 0, 0);
				holdNote.AnchorPoint = new Vector2(0, 1);
				holdNote.Parent = laneContainer.Notes;
			}
			
			TweenService.Create(holdNote, info, {
				Position: new UDim2(0, 0, yScale, 0),
			}).Play();
			
			laneHolds.set(lane, yScale);
			usedArrows.add(holdNote);
		}
	}
	
	for (const lane of laneFrames) {
		const laneNumber = tonumber(lane.Name);
		if (!laneNumber || laneNumber < 1 || laneNumber > totalLanes) lane.Destroy();
		else {
			for (const arrow of lane.Notes.GetChildren()) {
				if (!usedArrows.has(arrow as Types.UINote)) arrow.Destroy();
			}
		}
	}
}