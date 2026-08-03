package com.gandoni.quickjoin;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ConnectScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.network.ServerAddress;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.text.Text;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Точка входа мода. Вешает на главное меню кнопку, которая одним нажатием
 * подключает игрока к серверу режима (адрес берётся из config-файла лаунчера).
 */
public class QuickJoinClient implements ClientModInitializer {

    public static final Logger LOGGER = LoggerFactory.getLogger("gandoni-quickjoin");

    @Override
    public void onInitializeClient() {
        ScreenEvents.AFTER_INIT.register((client, screen, scaledWidth, scaledHeight) -> {
            if (screen instanceof TitleScreen) {
                addButton(screen, scaledWidth, scaledHeight);
            }
        });
    }

    private void addButton(Screen screen, int width, int height) {
        ServerConfig config = ServerConfig.load();
        if (config == null) {
            return; // сервер не задан — кнопку не показываем
        }

        ButtonWidget button = ButtonWidget
                .builder(Text.literal("▶ " + config.buttonLabel()), b -> connect(config))
                .dimensions(width / 2 - 100, height - 52, 200, 20)
                .build();

        Screens.getButtons(screen).add(button);
        LOGGER.info("Кнопка захода на сервер {} добавлена в меню", config.address());
    }

    private void connect(ServerConfig config) {
        MinecraftClient client = MinecraftClient.getInstance();
        Screen current = client.currentScreen;

        ServerInfo info = new ServerInfo(config.serverName(), config.address(), false);
        ServerAddress address = ServerAddress.parse(config.address());

        LOGGER.info("Подключаемся к серверу режима: {}", config.address());
        ConnectScreen.connect(current, client, address, info, false);
    }
}
