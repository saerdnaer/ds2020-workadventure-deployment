import {EnableCameraSceneName} from "./EnableCameraScene";
import {TextField} from "../Components/TextField";
import Image = Phaser.GameObjects.Image;
import Rectangle = Phaser.GameObjects.Rectangle;
import {LAYERS, loadAllLayers} from "../Entity/body_character";
import Sprite = Phaser.GameObjects.Sprite;
import Container = Phaser.GameObjects.Container;
import {gameManager} from "../Game/GameManager";

export const CustomizeSceneName = "CustomizeScene";

enum CustomizeTextures{
    icon = "icon",
    arrowRight = "arrow_right",
    mainFont = "main_font",
    arrowUp = "arrow_up",
}

export class CustomizeScene extends Phaser.Scene {

    private textField!: TextField;
    private enterField!: TextField;

    private arrowRight!: Image;
    private arrowLeft!: Image;

    private arrowDown!: Image;
    private arrowUp!: Image;

    private Rectangle!: Rectangle;

    private logo!: Image;

    private selectedLayers: Array<number> = [0];
    private containersRow: Array<Array<Container>> = new Array<Array<Container>>();
    private activeRow = 0;

    private repositionCallback!: (this: Window, ev: UIEvent) => void;

    constructor() {
        super({
            key: CustomizeSceneName
        });
    }

    preload() {
        this.load.image(CustomizeTextures.arrowRight, "resources/objects/arrow_right.png");
        this.load.image(CustomizeTextures.icon, "resources/logos/tcm_full.png");
        this.load.image(CustomizeTextures.arrowUp, "resources/objects/arrow_up.png");
        this.load.bitmapFont(CustomizeTextures.mainFont, 'resources/fonts/arcade.png', 'resources/fonts/arcade.xml');

        //load all the png files
        loadAllLayers(this.load);
    }

    create() {
        this.textField = new TextField(this, this.game.renderer.width / 2, 30, 'Customize your own Avatar!');
        this.textField.setOrigin(0.5).setCenterAlign();
        this.textField.setVisible(true);

        this.enterField = new TextField(this, this.game.renderer.width / 2, 500, 'you can start the game by pressing SPACE..');
        this.enterField.setOrigin(0.5).setCenterAlign();
        this.enterField.setVisible(true);

        this.logo = new Image(this, this.game.renderer.width - 30, this.game.renderer.height - 20, CustomizeTextures.icon);
        this.add.existing(this.logo);


        this.arrowRight = new Image(this, this.game.renderer.width*0.9, this.game.renderer.height/2, CustomizeTextures.arrowRight);
        this.add.existing(this.arrowRight);

        this.arrowLeft = new Image(this, this.game.renderer.width/9, this.game.renderer.height/2, CustomizeTextures.arrowRight);
        this.arrowLeft.flipX = true;
        this.add.existing(this.arrowLeft);


        this.Rectangle = this.add.rectangle(this.cameras.main.worldView.x + this.cameras.main.width / 2, this.cameras.main.worldView.y + this.cameras.main.height / 2, 32, 33)
        this.Rectangle.setStrokeStyle(2, 0xFFFFFF);
        this.add.existing(this.Rectangle);

        this.arrowDown = new Image(this, this.game.renderer.width - 30, 100, CustomizeTextures.arrowUp);
        this.arrowDown.flipY = true;
        this.add.existing(this.arrowDown);

        this.arrowUp = new Image(this, this.game.renderer.width - 30, 60, CustomizeTextures.arrowUp);
        this.add.existing(this.arrowUp);

        this.createCustomizeLayer(0, 0, 0);
        this.createCustomizeLayer(0, 0, 1);
        this.createCustomizeLayer(0, 0, 2);
        this.createCustomizeLayer(0, 0, 3);
        this.createCustomizeLayer(0, 0, 4);
        this.createCustomizeLayer(0, 0, 5);

        this.moveLayers();
        this.input.keyboard.on('keyup-ENTER', () => {
            const layers: string[] = [];
            let i = 0;
            for (const layerItem of this.selectedLayers) {
                if (layerItem !== undefined) {
                    layers.push(LAYERS[i][layerItem].name);
                }
                i++;
            }

            gameManager.setCharacterLayers(layers);

            return this.scene.start(EnableCameraSceneName);
        });

        this.input.keyboard.on('keydown-RIGHT', () => {
            if (this.selectedLayers[this.activeRow] === undefined) {
                this.selectedLayers[this.activeRow] = 0;
            }
            if (this.selectedLayers[this.activeRow] < LAYERS[this.activeRow].length - 1) {
                this.selectedLayers[this.activeRow]++;
                this.moveLayers();
                this.updateSelectedLayer();
            }
        });

        this.input.keyboard.on('keydown-LEFT', () => {
            if (this.selectedLayers[this.activeRow] > 0) {
                if (this.selectedLayers[this.activeRow] === 0) {
                    delete this.selectedLayers[this.activeRow];
                } else {
                    this.selectedLayers[this.activeRow]--;
                }
                this.moveLayers();
                this.updateSelectedLayer();
            }
        });

        this.input.keyboard.on('keydown-DOWN', () => {
            if (this.activeRow < LAYERS.length - 1) {
                this.activeRow++;
                this.moveLayers();
            }
        });

        this.input.keyboard.on('keydown-UP', () => {
            if (this.activeRow > 0) {
                this.activeRow--;
                this.moveLayers();
            }
        });

        this.repositionCallback = this.reposition.bind(this);
        window.addEventListener('resize', this.repositionCallback);

    }
    update(time: number, delta: number): void {
        super.update(time, delta);
        this.enterField.setVisible(!!(Math.floor(time / 500) % 2));
    }

    /**
     * @param x, the layer's vertical position
     * @param y, the layer's horizontal position
     * @param layerNumber, index of the LAYERS array
     * create the layer and display it on the scene
     */
    private createCustomizeLayer(x: number, y: number, layerNumber: number): void {
        this.containersRow[layerNumber] = new Array<Container>();
        let alpha = 0;
        let layerPosX = 0;
        for (let i = 0; i < LAYERS[layerNumber].length; i++) {
            const container = this.generateCharacter(300 + x + layerPosX, y, layerNumber, i);

            this.containersRow[layerNumber][i] = container;
            this.add.existing(container);
            layerPosX += 30;
            alpha += 0.1;
        }
    }

    /**
     * Generates a character from the current selected items BUT replaces
     * one layer item with an item we pass in parameter.
     *
     * Current selected items are fetched from this.selectedLayers
     *
     * @param x,
     * @param y,
     * @param layerNumber, The selected layer number (0 for body...)
     * @param selectedItem, The number of the item select (0 for black body...)
     */
    private generateCharacter(x: number, y: number, layerNumber: number, selectedItem: number) {
        return new Container(this, x, y,this.getContainerChildren(layerNumber,selectedItem));
    }

    private getContainerChildren(layerNumber: number, selectedItem: number): Array<Sprite> {
        const children: Array<Sprite> = new Array<Sprite>();
        for (let j = 0; j <= layerNumber; j++) {
            if (j === layerNumber) {
                children.push(this.generateLayers(0, 0, LAYERS[j][selectedItem].name));
            } else {
                const layer = this.selectedLayers[j];
                if (layer === undefined) {
                    continue;
                }
                children.push(this.generateLayers(0, 0, LAYERS[j][layer].name));
            }
         }
        return children;
    }

    /**
     * Move the layer left, right, up and down and update the selected layer
     */
    private moveLayers(): void {
        const screenCenterX = this.cameras.main.worldView.x + this.cameras.main.width / 2;
        const screenCenterY = this.cameras.main.worldView.y + this.cameras.main.height / 2;
        const screenWidth = this.game.renderer.width;
        const screenHeight = this.game.renderer.height;
        for (let i = 0; i < this.containersRow.length; i++) {
            for (let j = 0; j < this.containersRow[i].length; j++) {
                    let selectedX = this.selectedLayers[i];
                    if (selectedX === undefined) {
                        selectedX = 0;
                    }
                    this.containersRow[i][j].x = screenCenterX + (j - selectedX) * 40;
                    this.containersRow[i][j].y = screenCenterY + (i - this.activeRow) * 40;
                    const alpha1 = Math.abs(selectedX - j)*47*2/screenWidth;
                    const alpha2 = Math.abs(this.activeRow - i)*49*2/screenHeight;
                    this.containersRow[i][j].setAlpha((1 -alpha1)*(1 - alpha2));
            }

        }
    }

    /**
     * @param x, the sprite's vertical position
     * @param y, the sprites's horizontal position
     * @param name, the sprite's name
     * @return a new sprite
     */
    private generateLayers(x: number, y: number, name: string): Sprite {
        return new Sprite(this, x, y, name);
    }

    private updateSelectedLayer() {
        for(let i = 0; i < this.containersRow.length; i++){
            for(let j = 0; j < this.containersRow[i].length; j++){
               const children = this.getContainerChildren(i, j);
               this.containersRow[i][j].removeAll(true);
                this.containersRow[i][j].add(children);
            }
        }
     }

     private reposition() {
        this.moveLayers();

        this.Rectangle.x = this.cameras.main.worldView.x + this.cameras.main.width / 2;
        this.Rectangle.y = this.cameras.main.worldView.y + this.cameras.main.height / 2;

        this.textField.x = this.game.renderer.width/2;

        this.logo.x = this.game.renderer.width - 30;
        this.logo.y = this.game.renderer.height - 20;

        this.arrowUp.x = this.game.renderer.width - 30;
        this.arrowUp.y = 60;

        this.arrowDown.x = this.game.renderer.width - 30;
        this.arrowDown.y = 100;

        this.arrowLeft.x = this.game.renderer.width/9;
        this.arrowLeft.y = this.game.renderer.height/2;

        this.arrowRight.x = this.game.renderer.width*0.9;
        this.arrowRight.y = this.game.renderer.height/2;
     }
}
